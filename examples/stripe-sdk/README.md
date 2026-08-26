# Stripe SDK recurring billing

This executable example uses the official `stripe` Node SDK against an isolated localhost2137
Stripe account. Application code keeps the normal `customers`, `subscriptions`, and `invoices`
SDK calls; `createStripeSdkFetch` only redirects the SDK's fixed API origin to the selected local
instance.

The current local compatibility slice creates products and prices through the typed instance
control API, then exercises the supported Stripe HTTP surface through the official SDK. It needs
no Stripe account, network access, or real credentials.

```sh
pnpm --filter @localhost2137/example-stripe-sdk test
```
