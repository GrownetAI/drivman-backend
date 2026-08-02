/**
 * Claims a webhook event id exactly once. The store's insert is expected to
 * enforce uniqueness (a DB unique index in production); a duplicate insert
 * signals "already handled" via a thrown error carrying code 11000, so a
 * replayed delivery is dropped without touching the order it describes.
 */
export const createWebhookIdempotencyGuard = (store) => ({
    /** Returns true the first time this eventId is seen, false on any replay. */
    claim: async (eventId, eventType) => {
        try {
            await store.insert(eventId, eventType);
            return true;
        } catch (err) {
            if (err?.code === 11000) return false;
            throw err;
        }
    },
});

export const mongoWebhookEventStore = (WebhookEvent) => ({
    insert: (eventId, event) => WebhookEvent.create({ eventId, event }),
});
