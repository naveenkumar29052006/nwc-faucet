# NWC Faucet

Build and test your application end to end without needing a real lightning wallet!

NWC Faucet allows you to create test wallets / dummy NWC connections for rapid app development and testing.

[Try it now](https://faucet.nwc.dev)

Powered by [Alby Hub](https://github.com/getAlby/hub)

## API

To create a new wallet with a starting balance of 10,000 sats:

```bash
curl -X POST https://faucet.nwc.dev?balance=10000
```

Then you can use the connection secret in any NWC application.

## Development

### Setup env

Configure your .env file for your Alby Hub based on where it is deployed.

⚠️ this app MUST be used with a hub that has **no channels**.

You can get the `ALBY_HUB_URL` and `AUTH_TOKEN` by logging into Alby Hub and Going to settings -> Developer. If you use Alby Cloud, you'll also need to provide `ALBY_HUB_NAME` and `ALBY_HUB_REGION` to route requests to your hub.

```bash
cp .env.example .env
```

```bash
yarn install
yarn dev
```

### Production

```bash
yarn build
yarn start
```
