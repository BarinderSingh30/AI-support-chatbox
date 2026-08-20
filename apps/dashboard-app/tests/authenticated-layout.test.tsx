import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const useSession = vi.fn();
const useListOrganizations = vi.fn();
const setActive = vi.fn();
const signOut = vi.fn();

vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: { organization: { setActive }, signOut },
  useSession: () => useSession(),
  useListOrganizations: () => useListOrganizations(),
}));

const { AuthenticatedLayout } = await import('../src/screens/AuthenticatedLayout.tsx');

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/documents']}>
      <Routes>
        <Route path="/sign-in" element={<div>Sign-in page</div>} />
        <Route element={<AuthenticatedLayout />}>
          <Route path="documents" element={<div>Documents screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useListOrganizations.mockReset();
  setActive.mockReset();
  signOut.mockReset();
});

describe('AuthenticatedLayout', () => {
  it('redirects to sign-in when there is no session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    useListOrganizations.mockReturnValue({ data: null, isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText('Sign-in page')).toBeInTheDocument());
  });

  it('shows a message when the user belongs to no organization', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [], isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText(/don't belong to an organization/i)).toBeInTheDocument());
  });

  it('auto-activates the org when the user belongs to exactly one', async () => {
    setActive.mockResolvedValue({});
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }], isPending: false,
    });
    renderLayout();
    await waitFor(() => expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-1' }));
  });

  it('shows a picker when the user belongs to more than one organization', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }], isPending: false,
    });
    renderLayout();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument();
    expect(setActive).not.toHaveBeenCalled();
  });

  it('calling setActive from the picker activates that org', async () => {
    setActive.mockResolvedValue({});
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }], isPending: false,
    });
    renderLayout();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Globex' }));
    expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-2' });
  });

  it('renders the nav and the active screen once an org is active', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: 'org-1' } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [{ id: 'org-1', name: 'Acme' }], isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText('Documents screen')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('signs out when the sign-out button is clicked', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: 'org-1' } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [{ id: 'org-1', name: 'Acme' }], isPending: false });
    renderLayout();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Documents screen')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });
});
