-- A read of the profile that got no answer (an outage) is asked again after a short wait, and the date
-- of the last read stays what it is: the day a profile was really read.
ALTER TABLE "customer_identities" ADD COLUMN "profile_retry_after" TIMESTAMP(3);
