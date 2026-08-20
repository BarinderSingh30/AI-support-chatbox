import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { authClient, useListOrganizations, useSession } from '../lib/auth-client.ts';

const NAV_ITEMS = [
  { to: '/documents', label: 'Documents' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/widget', label: 'Widget' },
  { to: '/widget-keys', label: 'Widget keys' },
];

export function AuthenticatedLayout() {
  const { data: session, isPending: sessionPending } = useSession();
  const { data: organizations, isPending: orgsPending } = useListOrganizations();
  const [autoActivating, setAutoActivating] = useState(false);

  const activeOrgId = session?.session.activeOrganizationId ?? null;

  useEffect(() => {
    if (!organizations || organizations.length !== 1 || activeOrgId) return;
    setAutoActivating(true);
    void authClient.organization
      .setActive({ organizationId: organizations[0]!.id })
      .finally(() => setAutoActivating(false));
  }, [organizations, activeOrgId]);

  if (sessionPending || orgsPending || autoActivating) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>;
  }

  if (!session) return <Navigate to="/sign-in" replace />;

  if (!organizations || organizations.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center px-8 text-center text-gray-600">
        <p>You don&apos;t belong to an organization yet. Ask an admin to invite you.</p>
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 font-sans text-sm">
        <p className="text-gray-700">Choose an organization</p>
        {organizations.map((org) => (
          <button
            key={org.id}
            type="button"
            className="rounded-lg border border-gray-300 px-4 py-2 hover:bg-gray-50"
            onClick={() => void authClient.organization.setActive({ organizationId: org.id })}
          >
            {org.name}
          </button>
        ))}
      </div>
    );
  }

  const activeOrg = organizations.find((o) => o.id === activeOrgId);

  return (
    <div className="flex h-screen w-screen font-sans text-sm text-gray-900">
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white p-4">
        <div className="mb-6">
          <p className="text-xs uppercase text-gray-400">Organization</p>
          <p className="font-semibold">{activeOrg?.name ?? 'Unknown'}</p>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                'block rounded-lg px-3 py-2 ' + (isActive ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => void authClient.signOut()}
          className="mt-4 rounded-lg border border-gray-300 px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
