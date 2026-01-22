import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyBody from "@fastify/formbody";
import fastifyCors from "@fastify/cors";
import path from "path";

const APP_NAME_PREFIX = "nwc";

function removeTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.AUTH_TOKEN}`,
    "AlbyHub-Name": process.env.ALBY_HUB_NAME || "",
    "AlbyHub-Region": process.env.ALBY_HUB_REGION || "",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function getAlbyHubUrl() {
  const albyHubUrl = process.env.ALBY_HUB_URL;
  if (!albyHubUrl) {
    throw new Error("No ALBY_HUB_URL set");
  }
  return removeTrailingSlash(albyHubUrl);
}

async function createApp() {
  const hubUrl = getAlbyHubUrl();
  const endpoint = new URL("/api/apps", hubUrl);
  console.log(`Creating app at: ${endpoint.toString()}`);

  const newAppResponse = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      name: APP_NAME_PREFIX + Math.floor(Date.now() / 1000),
      pubkey: process.env.NWC_PUBKEY || "", // Optional pubkey if relevant
      budgetRenewal: "monthly",
      maxAmount: 0,
      scopes: [
        "get_info",
        "pay_invoice",
        "get_balance",
        "make_invoice",
        "lookup_invoice",
        "list_transactions",
        "notifications",
      ],
      returnTo: "",
      isolated: true,
      metadata: {
        app_store_app_id: "nwc-faucet",
      },
    }),
    headers: getHeaders(),
  });

  if (!newAppResponse.ok) {
    const text = await newAppResponse.text();
    console.error(`Failed to create app at ${endpoint}: ${newAppResponse.status} ${newAppResponse.statusText} - ${text}`);

    if (newAppResponse.status === 404) {
      throw new Error(`Endpoint not found (${endpoint}). Please check your ALBY_HUB_URL int .env. It should point to your Alby Hub instance, NOT api.getalby.com.`);
    }
    throw new Error("Failed to create app: " + text);
  }

  const newApp = (await newAppResponse.json()) as {
    pairingUri: string;
    id: string;
    name: string;
  };

  if (!newApp.pairingUri) {
    throw new Error("No pairing URI in create app response");
  }

  return newApp;
}

async function transferToApp(appId: string, amountSat: number): Promise<void> {
  const transferResponse = await fetch(
    new URL("/api/transfers", getAlbyHubUrl()),
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        toAppId: appId,
        amountSat,
      }),
    },
  );

  if (!transferResponse.ok) {
    throw new Error("Failed to transfer: " + (await transferResponse.text()));
  }
}

async function createLightningAddress(
  appId: string,
  address: string,
): Promise<void> {
  console.log("Creating lightning address", address, appId);
  const response = await fetch(
    new URL("/api/lightning-addresses", getAlbyHubUrl()),
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        address,
        appId,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      "Failed to create lightning address: " + (await response.text()),
    );
  }
}

const fastify = Fastify({ logger: true });

// Register static file serving for the HTML page
fastify.register(fastifyStatic, {
  root: path.join(__dirname),
  prefix: "/",
});

fastify.register(fastifyBody);
fastify.register(fastifyCors, {
  origin: "*",
});

fastify.get("/", async (request, reply) => {
  return reply.sendFile("index.html");
});

fastify.post("/", async (request, reply) => {
  const query = request.query as { balance?: string } | undefined;
  const body = request.body as { balance?: string } | undefined;
  const balance = body?.balance
    ? parseInt(body.balance, 10)
    : query?.balance
      ? parseInt(query.balance, 10)
      : undefined;

  try {
    const newApp = await createApp();

    if (balance !== undefined && balance > 0) {
      await transferToApp(newApp.id, balance);
    }

    await createLightningAddress(newApp.id, newApp.name);

    return `${newApp.pairingUri}&lud16=${newApp.name}@getalby.com`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    reply.status(500).send({ error: errorMessage });
    throw error;
  }
});

async function payInvoice(invoice: string): Promise<{
  amount: number;
  description: string;
  destination: string;
  fee: number;
  payment_hash: string;
  payment_preimage: string;
  payment_request: string;
}> {
  const response = await fetch(new URL("/api/payments/bolt11", getAlbyHubUrl()), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      invoice,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to pay invoice: " + (await response.text()));
  }

  return response.json();
}

async function resolveLightningAddress(address: string, amountSat: number) {
  const [user, domain] = address.split("@");
  if (!user || !domain) {
    throw new Error("Invalid Lightning Address format");
  }

  const lnurlUrl = `https://${domain}/.well-known/lnurlp/${user}`;
  console.log(`Fetching LNURL params from ${lnurlUrl}`);

  const paramsRes = await fetch(lnurlUrl);
  if (!paramsRes.ok) {
    throw new Error(`Failed to resolve LN Address: ${paramsRes.status} ${paramsRes.statusText}`);
  }

  const params = await paramsRes.json();

  if (params.tag !== "payRequest") {
    throw new Error("Invalid LNURL response: tag is not payRequest");
  }

  const minSendable = params.minSendable / 1000; // millisats to sats
  const maxSendable = params.maxSendable / 1000;

  if (amountSat < minSendable || amountSat > maxSendable) {
    throw new Error(`Amount must be between ${minSendable} and ${maxSendable} sats. (Address max: ${maxSendable})`);
  }

  const callbackUrl = new URL(params.callback);
  callbackUrl.searchParams.append("amount", (amountSat * 1000).toString()); // millisats

  console.log(`Fetching invoice from callback: ${callbackUrl.toString()}`);
  const invoiceRes = await fetch(callbackUrl);
  if (!invoiceRes.ok) {
    throw new Error(`Failed to fetch invoice: ${invoiceRes.status} ${invoiceRes.statusText}`);
  }

  const invoiceData = await invoiceRes.json();
  if (!invoiceData.pr) {
    console.error("Invoice response missing 'pr':", invoiceData);
    throw new Error("Invalid invoice response from callback");
  }

  return invoiceData.pr;
}

fastify.post("/pay", async (request, reply) => {
  const body = request.body as { lightningAddress?: string; amount?: string } | undefined;
  const lightningAddress = body?.lightningAddress;
  const amount = parseInt(body?.amount || "1000");

  if (!lightningAddress) {
    reply.status(400).send({ error: "Lightning address is required" });
    return;
  }

  // Basic LN Address validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(lightningAddress)) {
    reply.status(400).send({ error: "Invalid Lightning Address format" });
    return;
  }

  try {
    console.log(`Resolving LN Address: ${lightningAddress} for ${amount} sats`);

    const invoice = await resolveLightningAddress(lightningAddress, amount);

    console.log(`Paying invoice: ${invoice}`);
    const result = await payInvoice(invoice);

    return reply.send({
      message: "Payment successful",
      preimage: result.payment_preimage,
      amount: result.amount,
      fee: result.fee
    });
  } catch (error) {
    console.error("Payment flow failed:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    reply.status(500).send({ error: errorMessage });
  }
});


const start = async () => {
  try {
    await fastify.listen({
      port: parseInt(process.env.PORT || "3000"),
      host: "0.0.0.0",
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
