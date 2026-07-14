# NestJS Migration Notes

The MVP uses plain Node.js to avoid dependency setup during the hackathon, but the boundaries are already close to a NestJS backend.

## Suggested Modules

```text
OffersModule
  OffersController
  OffersService
  OfferStore provider

InvoicesModule
  InvoicesController
  InvoiceService
  InvoiceAdapter provider
  FiberRpcClient provider

FiberAddressModule
  FiberAddressController
  FiberAddressService

Protocol package
  imported as @fiber-offers/protocol
```

## Mapping

```text
apps/resolver/src/server.js
  -> controllers and DTO validation

apps/resolver/src/store.js
  -> repository/provider

apps/resolver/src/invoice-adapter.js
  -> InvoiceAdapter interface with Mock and FiberRpc implementations

apps/resolver/src/fiber-rpc.js
  -> injectable FiberRpcClient

packages/protocol
  -> shared library, no Nest dependency

packages/sdk
  -> external app/wallet SDK
```

## Recommended Next Step

Keep the protocol and SDK as packages. Replace only the HTTP server with NestJS when the resolver needs guards, DTO pipes, OpenAPI docs, background jobs, or a database-backed repository.
