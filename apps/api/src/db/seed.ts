import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from './client.ts';
import { withTenant } from './with-tenant.ts';
import { documents, organization, orgSettings } from './schema/index.ts';

/**
 * Two demo tenants with deliberately different content, so the isolation
 * guarantee is visible in the UI and not just in a test.
 */
const DEMOS = [
  {
    id: 'demo-acme',
    name: 'Acme Robotics',
    docs: [
      { title: 'Acme Returns Policy', body: 'Acme accepts returns within 30 days of delivery.' },
      { title: 'Acme Warranty', body: 'All Acme robots carry a 24-month limited warranty.' },
    ],
  },
  {
    id: 'demo-globex',
    name: 'Globex Software',
    docs: [
      { title: 'Globex Billing FAQ', body: 'Globex bills monthly on the date you subscribed.' },
      { title: 'Globex SLA', body: 'Globex guarantees 99.9% uptime for Enterprise plans.' },
    ],
  },
];

for (const demo of DEMOS) {
  await db.delete(organization).where(eq(organization.id, demo.id));
  await db.insert(organization).values({
    id: demo.id, name: demo.name, slug: demo.id, createdAt: new Date(),
  });

  await withTenant(demo.id, async (tx) => {
    await tx.insert(orgSettings).values({
      orgId: demo.id,
      welcomeMessage: `Hi! Ask me anything about ${demo.name}.`,
      noAnswerMessage: "I couldn't find that in our documentation. Please contact support.",
    });
    for (const doc of demo.docs) {
      await tx.insert(documents).values({
        orgId: demo.id,
        title: doc.title,
        sourceType: 'paste',
        contentHash: randomUUID(),
        status: 'pending',
      });
    }
  });

  console.log(`seeded ${demo.name} (${demo.docs.length} documents)`);
}

await pool.end();
