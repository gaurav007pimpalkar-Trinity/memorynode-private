import { vi } from "vitest";

const makeStripe = () => {
  const stripeCtor = vi.fn(() => ({
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
  }));
  stripeCtor.createFetchHttpClient = vi.fn(() => ({}));
  stripeCtor.createSubtleCryptoProvider = vi.fn(() => ({}));
  return stripeCtor;
};

const stripeMock = makeStripe();

vi.mock("stripe", () => ({
  __esModule: true,
  default: stripeMock,
  Stripe: stripeMock,
}));
