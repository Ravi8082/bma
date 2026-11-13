/**
 * Onboarding state machine (WhatsApp-first, resumable).
 *
 * States: AWAITING_LANGUAGE → AWAITING_SHOP_NAME → AWAITING_CATEGORY →
 *         AWAITING_CONSENT → AWAITING_FIRST_ENTRY_DEMO → COMPLETE
 *
 * Idempotent per inbound message ID and per step key.
 */

export type OnboardingState =
  | "AWAITING_LANGUAGE"
  | "AWAITING_SHOP_NAME"
  | "AWAITING_CATEGORY"
  | "AWAITING_CONSENT"
  | "AWAITING_FIRST_ENTRY_DEMO"
  | "COMPLETE";

export interface OnboardingContext {
  shopId: string;
  conversationId: string;
  state: OnboardingState;
  language: string | null;
  shopName: string | null;
  presetKey: string | null;
  invalidCount: number;
  lastMessageId: string | null;
}

export const VALID_TRANSITIONS: Record<OnboardingState, OnboardingState[]> = {
  AWAITING_LANGUAGE: ["AWAITING_SHOP_NAME"],
  AWAITING_SHOP_NAME: ["AWAITING_CATEGORY"],
  AWAITING_CATEGORY: ["AWAITING_CONSENT"],
  AWAITING_CONSENT: ["AWAITING_FIRST_ENTRY_DEMO"],
  AWAITING_FIRST_ENTRY_DEMO: ["COMPLETE"],
  COMPLETE: [],
};

export function isValidTransition(from: OnboardingState, to: OnboardingState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextState(current: OnboardingState): OnboardingState | null {
  const transitions = VALID_TRANSITIONS[current];
  return transitions && transitions.length > 0 ? (transitions[0] ?? null) : null;
}

export const MAX_INVALID_INPUTS = 3;

export function shouldShowHelp(invalidCount: number): boolean {
  return invalidCount >= MAX_INVALID_INPUTS;
}
