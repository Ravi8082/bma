# Web chat test channel

The test channel is a local-only simulator UI for exercising the backend without
Meta. It is mounted at `/test-channel` and is disabled in production unless
`TEST_CHANNEL=true` is set explicitly.

## What it is

- A mobile-friendly chat page (message box, reply buttons, paged lists, contact
  share, voice upload placeholder) backed by the same in-memory simulator store
  as `/simulator`.
- Authenticated by a one-time link code issued per seller through the admin
  endpoint `POST /test-channel/admin/codes` with the `x-test-channel-admin-token`
  header. The code is single-use and short lived; redeeming it sets an HttpOnly
  session cookie.
- Rate limited per session (default 20 messages/minute, configurable via
  `TEST_CHANNEL_RATE_LIMIT_PER_MINUTE`).
- Every inbound message goes through `persistInboundMessage`, the same
  persist-before-acknowledge path as the WhatsApp webhook, so a 201 is only
  returned after the row is committed to `app.inbox_messages`.

## Issuing a link

```bash
curl -X POST http://localhost:4000/test-channel/admin/codes \
  -H "x-test-channel-admin-token: $TEST_CHANNEL_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"shopId":"<shop uuid>","phone":"+919876543210"}'
```

Open the returned URL (or paste the code into the page). The link can be
forwarded to a phone for ngrok-based testing:

```bash
ngrok http 4000
# then issue a code against https://<ngrok-host>/test-channel/admin/codes
# and open https://<ngrok-host>/test-channel/?code=<code> on the phone
```

## What it does NOT test

- WhatsApp message templates (no template send path is exercised).
- The 24-hour service window or its fallback template behaviour.
- Status webhooks (delivery/read receipts from Meta).
- Real WhatsApp interactive button or list payloads: the page sends the button/list
  id as a synthetic reply, which the backend treats as a `button_reply` /
  `list_reply`. Layout, rendering and provider-side validation are not covered.
- Media download or voice transcription (voice upload is a placeholder).
