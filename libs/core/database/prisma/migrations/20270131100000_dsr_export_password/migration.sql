-- The ZIP of an access or portability export is encrypted (Step 7.2-H2b-3c): ZIP AES-256 with a random password per request. The password is kept
-- here SEALED with the credentials key (AES-256-GCM, bound to the request id as additional data, opened with the rotation machinery of the
-- credentials) and is handed to the person once, in the answer that spends their download link. It is cleared with the file (`result_key`).
-- A completed export with no sealed password is an export made before this column: the download refuses it.
ALTER TABLE "data_subject_requests" ADD COLUMN "result_password_sealed" BYTEA;
