-- 0011_inbox_sequence_grant.sql
--
-- 0009 created app.inbox_arrival_seq but did not grant it to the runtime role, so the
-- webhook could not allocate an arrival sequence and every inbound POST returned 500.
-- Grant only what the queue needs: USAGE (nextval) and SELECT (currval), never ownership.

GRANT USAGE, SELECT ON SEQUENCE app.inbox_arrival_seq TO bma_app;
