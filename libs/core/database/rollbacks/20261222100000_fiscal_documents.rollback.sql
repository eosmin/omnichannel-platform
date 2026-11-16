-- Rolls back 20261222100000_fiscal_documents. DESTRUCTIVE: it drops the fiscal documents and the issuer of every organization. They are
-- legal evidence: export both tables before running it anywhere that issued a real document. Safe to run twice.
BEGIN;
DROP TRIGGER IF EXISTS trg_fiscal_documents_scope ON fiscal_documents;
DROP TRIGGER IF EXISTS trg_fiscal_documents_no_truncate ON fiscal_documents;
DROP TRIGGER IF EXISTS trg_fiscal_documents_guard ON fiscal_documents;
DROP FUNCTION IF EXISTS check_fiscal_document_scope();
DROP FUNCTION IF EXISTS forbid_fiscal_document_truncate();
DROP FUNCTION IF EXISTS fiscal_document_guard();
DROP TABLE IF EXISTS fiscal_documents;
DROP TABLE IF EXISTS fiscal_issuers;
COMMIT;
