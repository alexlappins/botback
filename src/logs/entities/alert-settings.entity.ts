import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Server Alerts (watchdog) settings — TZ §6. Premium-gated at runtime via
 * PremiumService.isPremium(); rows survive expiry and re-activate on renewal.
 * The guild OWNER is always a recipient and is not stored here.
 */
@Entity('alert_settings')
export class AlertSettings {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** Up to 3 extra recipients (user ids), owner excluded. */
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  recipients: string[];

  @Column({ name: 'd1_enabled', type: 'boolean', default: true })
  d1Enabled: boolean;
  @Column({ name: 'd2_enabled', type: 'boolean', default: true })
  d2Enabled: boolean;
  @Column({ name: 'd3_enabled', type: 'boolean', default: true })
  d3Enabled: boolean;
  @Column({ name: 'd4_enabled', type: 'boolean', default: true })
  d4Enabled: boolean;
  @Column({ name: 'd5_enabled', type: 'boolean', default: true })
  d5Enabled: boolean;
  @Column({ name: 'd6_enabled', type: 'boolean', default: true })
  d6Enabled: boolean;
  @Column({ name: 'd7_enabled', type: 'boolean', default: true })
  d7Enabled: boolean;
  @Column({ name: 'd8_enabled', type: 'boolean', default: true })
  d8Enabled: boolean;
  @Column({ name: 'd9_enabled', type: 'boolean', default: true })
  d9Enabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
