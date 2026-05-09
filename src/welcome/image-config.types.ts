/**
 * Shared shape of image-related JSONB configs on WelcomeConfig / GoodbyeConfig.
 * Coordinates use canvas pixels: 1024 (W) × 400 (H).
 */
export const CANVAS_W = 1024;
export const CANVAS_H = 400;

export interface AvatarConfig {
  enabled: boolean;
  /** Center X in px */
  x: number;
  /** Center Y in px */
  y: number;
  /** Outer radius in px */
  radius: number;
  borderColor: string;
  borderWidth: number;
}

export interface ImageTextBlock {
  enabled: boolean;
  /** May contain {user.name}, {server.name} etc — resolved at render time. */
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  /** Optional contrast stroke around text */
  strokeColor?: string | null;
  strokeWidth?: number;
}

export interface UsernameConfig extends Omit<ImageTextBlock, 'text'> {
  // Always renders {user.name}
}

export interface BackgroundConfig {
  /** Solid fill behind the optional background image */
  fillColor: string;
}

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  enabled: true,
  x: CANVAS_W / 2,
  y: 170,
  radius: 80,
  borderColor: '#ffffff',
  borderWidth: 6,
};

export const DEFAULT_USERNAME_CONFIG: UsernameConfig = {
  enabled: true,
  x: CANVAS_W / 2,
  y: 290,
  fontSize: 36,
  color: '#ffffff',
  bold: true,
  align: 'center',
  strokeColor: '#000000',
  strokeWidth: 3,
};

export const DEFAULT_TEXT_CONFIG: ImageTextBlock = {
  enabled: true,
  text: 'Welcome',
  x: CANVAS_W / 2,
  y: 60,
  fontSize: 30,
  color: '#ffffff',
  bold: true,
  align: 'center',
  strokeColor: '#000000',
  strokeWidth: 2,
};

export const DEFAULT_BG_FILL = '#1f1f29';
