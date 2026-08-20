-- Raise the relevance-gate threshold from 0.35 to a measured 0.65.
--
-- Measured against gemini-embedding-001 at 768 dimensions on a support corpus:
--   on-topic queries   0.721 - 0.786
--   off-topic queries  0.526 - 0.576
-- Cosine similarity has a high floor here, so 0.35 could never fire and every
-- off-topic question was reaching the model. 0.65 sits inside the gap.

ALTER TABLE "org_settings" ALTER COLUMN "min_score" SET DEFAULT 0.65;--> statement-breakpoint
UPDATE "org_settings" SET min_score = 0.65 WHERE min_score = 0.35;
