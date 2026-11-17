# Meta staging checklist (manual)

**Phase 3 is not done until this checklist is confirmed by the user.**

Run these steps against a real Meta test number in a staging environment.
Do NOT use production credentials.

## Prerequisites
- [ ] Meta test number provisioned in WhatsApp Business API
- [ ] Webhook URL configured in Meta developer console
- [ ] Verify token matches `WHATSAPP_VERIFY_TOKEN` env
- [ ] App secret matches `WHATSAPP_APP_SECRET` env
- [ ] Access token has `whatsapp_business_messaging` permission
- [ ] Phone number ID configured in `WHATSAPP_PHONE_NUMBER_ID`

## Webhook verification
- [ ] `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>` returns 200 with challenge
- [ ] Wrong verify token → 403
- [ ] Missing params → 400

## Text messages
- [ ] Send "hello" from test number → webhook received, signature verified, message persisted
- [ ] Send a second identical message → idempotent (one row, one processing)
- [ ] Send a message with a SQL injection payload → persisted as a value, no injection effect
- [ ] Send a message >1 MB → rejected with 413, no DB write

## Voice messages
- [ ] Send a voice note → media fetched from Meta domain, encrypted, stored
- [ ] Voice note with unsupported format → polite reply, no crash

## Image messages
- [ ] Send an image → media fetched, magic-byte checked, encrypted, stored
- [ ] Image with wrong magic bytes → rejected

## Button replies
- [ ] Send a button reply (Confirm) → references draft ID, processes in order
- [ ] Send Confirm before Draft → held for 5s reorder window, then processed or dead-lettered with polite reply

## Status updates
- [ ] Send a message → status webhook (sent) → `whatsapp_messages.status = SENT`
- [ ] Status webhook (delivered) → status = DELIVERED
- [ ] Status webhook (read) → status = READ
- [ ] Out-of-order status (read before delivered) → READ applied, DELIVERED ignored
- [ ] Duplicate status webhook → idempotent

## Template send
- [ ] Send a template message → outbound row created, status tracked
- [ ] Template send failure → outbox retry, dead letter after 3 attempts

## Security
- [ ] Webhook with bad signature → 401, zero DB writes
- [ ] Replay of a valid webhook → idempotent (no duplicate processing)
- [ ] Raw payload contains no access token
- [ ] Logs contain no raw phone or message body

## Outbound pre-checks
- [ ] Opted-out customer → message not sent, audit row written
- [ ] Outside 24-hour window without template → message not sent
- [ ] Quiet hours → message delayed
- [ ] Cost cap exceeded → message delayed with alert

## Backpressure
- [ ] 100+ queued messages for one shop → new messages delayed, not dropped
- [ ] 10,000+ queued globally → alert raised, graceful degradation

## Edit flow (new)
- [ ] Tap Edit on a draft -> "What to change? Name / Amount / Type" buttons appear
- [ ] Tap Edit -> Name, send new name -> draft updated, confirmation re-sent
- [ ] Tap Edit -> Amount, send "abc" -> rejected, draft unchanged
- [ ] Tap Edit -> Type, send "credit" -> is_credit_sale updated
- [ ] Tap Edit on a confirmed draft -> rejected

## Enabling undo/edit for one shop
Undo/edit is off by default for every shop. Turn it on for a single shop (seller-facing
text commands and the button taps are gated by the same flag):

```sql
UPDATE app.shop_settings SET undo_edit_enabled = true  WHERE shop_id = '<shop-uuid>';
UPDATE app.shop_settings SET undo_edit_enabled = false WHERE shop_id = '<shop-uuid>'; -- turn off again
```

Run this as the migrator/owner role, not as `bma_app`, and only for the shop under test.
The evening summary (`summary` / `hisaab`) is not gated by this flag.

## Sign-off
- [ ] All items above verified by: _______________
- [ ] Date: _______________
- [ ] Any issues found: _______________
