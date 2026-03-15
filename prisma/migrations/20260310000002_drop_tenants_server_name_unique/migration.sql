-- Allow multiple tenants per server.
-- A server can have many tenants; each tenant is uniquely identified
-- by their own secret_id and secret_code (those unique indexes are kept).
DROP INDEX IF EXISTS "tenants_server_name_key";
