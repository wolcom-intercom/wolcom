# Wolcom 0.4.1

## Hosted onboarding, economy and dual GitHub repositories

### Register first, pay inside Wolcom
Customers can now create an organization and Customer Admin account without paying immediately. They can log in to Wolcom Control, choose a configured plan and start Stripe Checkout there. New event creation remains blocked until payment is confirmed or HQ grants sponsored/manual access.

### Entitlements
HQ can set access mode per customer to `payment`, `sponsored` or `manual`, optionally with an expiry date and note. Running events are not terminated because of billing state; the gate applies when creating new events.

### Economy views
Customer Control shows current plan/status, next/current period and payment history. HQ shows customer payment/access state, upcoming billing periods and previous payments.

### Two GitHub repositories
HQ → GitHub now has separate configurations for:
- `open_source`: public AGPL repository. Sync runs `scripts/export-open-source.sh` first, so `app/cloud/` is omitted.
- `cloud`: private repository with the complete hosted source tree.

Tokens/config are stored separately for the two targets.

## Installation
0.4.1 changes the updater itself, so install this release once via CLI:

```bash
tar -xzf wolcom-update-0.4.1.tar.gz
cd wolcom-0.4.1
sudo bash update.sh
```

After 0.4.1, normal app-only updates can again be installed through HQ.
