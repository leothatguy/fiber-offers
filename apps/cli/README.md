# @fiber-offers/cli

Command-line tools for independent Nervos Fiber Offers merchants.

The CLI creates a local lifecycle identity, verifies the configured Fiber node,
creates and signs offers, registers them with a resolver, lists inventory, and
cryptographically revokes offers.

## Install

```sh
npm install --global @fiber-offers/cli
```

Node.js 20.12 or newer is required.

## Initialize

```sh
fiber-offers init \
  --resolver-url https://fiber-offers.example.com \
  --fiber-rpc-url http://127.0.0.1:8227
```

The command creates a private environment file containing new resolver secrets.
Start the matching self-hosted resolver with that environment, then verify the
node connection:

```sh
fiber-offers doctor
```

## Create an offer

```sh
fiber-offers create \
  --description "Coffee" \
  --amount 100000000 \
  --username coffee
```

The CLI passes amounts in base units. One CKB is `100000000` shannons.
Lifecycle keys and environment files are private local operator material and
must not be committed.

See the [complete CLI guide](https://github.com/leothatguy/fiber-offers/blob/main/docs/cli.md)
and [independent merchant guide](https://github.com/leothatguy/fiber-offers/blob/main/docs/independent-merchant.md)
for node, resolver, Fiber Address, and production setup.

## License

MIT
