# Wolcom 0.4.4

Mobile hotfix for the blank event/login screen on phones.

## Fix

0.4.3 contained this mobile rule:

```css
.login-card:first-child { display:none }
```

It was intended to hide only the marketing/intro card on the public homepage, but it also hid the event PIN card because that card is the first and only `.login-card` on the event page.

0.4.4 scopes the rule to the homepage two-card wrapper:

```css
.landing-main > .login-wrap > .login-card:first-child { display:none }
```

Event login, HQ login and other single login cards therefore remain visible on mobile.

This is an app-only update. PostgreSQL, Redis, LiveKit and the updater stay running.
