-- Run as bootstrap administrator AFTER all four fresh schemas exist.
GRANT USAGE ON SCHEMA opendoc_accounts, opendoc_documents, opendoc_live, opendoc_sessions TO opendoc_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA opendoc_accounts TO opendoc_runtime;
GRANT UPDATE(singleton) ON opendoc_accounts.account_state TO opendoc_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA opendoc_documents, opendoc_live TO opendoc_runtime;
GRANT SELECT ON opendoc_sessions.browser_auth_state TO opendoc_runtime;
GRANT UPDATE(singleton) ON opendoc_sessions.browser_auth_state TO opendoc_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON opendoc_sessions.browser_auth_records TO opendoc_runtime;
