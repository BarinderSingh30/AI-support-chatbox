import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const signInEmail = vi.fn();
const navigateSpy = vi.fn();

vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: { signIn: { email: (...args: unknown[]) => signInEmail(...args) } },
}));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const { SignIn } = await import('../src/screens/SignIn.tsx');

afterEach(() => {
  cleanup();
  signInEmail.mockReset();
  navigateSpy.mockReset();
});

describe('SignIn', () => {
  it('submits the entered email and password', async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledWith({
      email: 'admin@acme.test', password: 'hunter22',
    }));
  });

  it('navigates to the dashboard root on success', async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('shows the server error and does not navigate on failure', async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: 'Invalid email or password' } });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeInTheDocument());
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('shows an error and re-enables the button when the request throws', async () => {
    signInEmail.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const button = await screen.findByRole('button', { name: /^sign in$/i });
    expect(button).not.toBeDisabled();
    expect(screen.getByText(/check your connection/i)).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
