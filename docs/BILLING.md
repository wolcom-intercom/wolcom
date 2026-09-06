# Wolcom Hosted billing

Wolcom 0.4.0 adds an optional hosted billing module. It is separate from the AGPL self-host export.

## Stripe setup

1. In Stripe, create recurring and/or one-time Products and Prices.
2. In Wolcom HQ → Betalning, save the Stripe Secret Key and webhook signing secret.
3. Add this webhook endpoint in Stripe:

   `https://call.wolcom.se/api/cloud/stripe/webhook`

4. Subscribe at least to:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the relevant `price_...` IDs into the Wolcom plans in HQ.
6. Test the Stripe connection and only then enable Online registration.

Stripe card data is never stored by Wolcom. The secret key and webhook signing secret are encrypted server-side with a key derived from the Wolcom session secret. `cloud_billing_config` table data is intentionally excluded from BackupHub exports and must be reconfigured after disaster restore.

## Payment behavior

- `active` / `trialing`: new events allowed.
- `past_due`: new events remain allowed during the configured grace period.
- `suspended` / `canceled` / expired Event Pass: new events are blocked.
- Existing active events are not automatically stopped because of billing status.
- HQ Owner can mark a customer as invoice, manual or free.

## Registration

`/signup` → Stripe Checkout → verified Stripe webhook → organization + Customer Admin account activated automatically.


## 0.4.1 onboarding and entitlement
Accounts are registered before payment. `cloud_subscriptions.access_mode` determines whether event creation is governed by Stripe (`payment`) or by HQ override (`sponsored` / `manual`). An optional `access_until` prevents indefinite complimentary access. Payment history is stored from verified Stripe invoice webhooks.
