import naturaLogoWhite from '@/assets/brand/natura-logo-white.svg';
import naturaMark from '@/assets/brand/natura-mark.svg';
import naturaMarkWhite from '@/assets/brand/natura-mark-white.svg';

/**
 * "Natura Therapy HUB — Powered by elyonpremium" (owner, 02.10.2026): the product's brand lines,
 * shared by the login and the sidebar. Brand names — the same words in every language, never
 * translated. The logos are naturatherapy.mk's own (#6aa291 = the logo green).
 */
export const BRAND = {
  product: 'Natura Therapy',
  hub: 'HUB',
  poweredBy: 'Powered by',
  maker: 'elyonpremium',
} as const;

export const BRAND_LOGO = {
  /** The full lockup (emblem + NATURA THERAPY), white — for the dark brand surfaces. */
  white: naturaLogoWhite,
  /** The emblem alone, in the logo green. */
  mark: naturaMark,
  /** The emblem alone, white. */
  markWhite: naturaMarkWhite,
} as const;
