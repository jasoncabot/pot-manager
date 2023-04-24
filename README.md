# Pot Manager

Lists the balances of pots in your Monzo account.

I currently use this to display kids pocket money on a home dashboard - fun times!

# How to use

- Navigate to http://localhost:8787/auth/monzo
- Authenticate with Monzo
- Authorize pot-manager and get your user id
- Take note of your user_id
- Navigate to http://localhost:8787/balances?user_id=<user_id>&secret=<base64(secret)>&pot_ids=<one>,<two>

# Setup

```
wrangler kv:namespace create STATE_TOKENS

yarn wrangler secret put CLIENT_ID
yarn wrangler secret put CLIENT_SECRET
yarn wrangler secret put BALANCE_SHARED_SECRET

yarn start
```

# Tunnelling

Tested locally by setting up a Cloudflare tunnel to my machine with:

```
cloudflared tunnel route dns <id> <url>
cloudflared tunnel run --url http://localhost:8787 <id>
```
