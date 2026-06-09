import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-guild override of who can use a particular leveling command.
 *
 * No row for (server, command) ⇒ fall back to the hard-coded default in
 * {@link LEVELING_COMMANDS}: /rank, /leaderboard → everyone; /xp/* → admins.
 *
 * `mode` = 'everyone' | 'admins' | 'roles'; `allowedRoleIds` is only honoured
 * when mode = 'roles', and admins (ManageMessages) always bypass it so they
 * can't lock themselves out of /xp recalc, etc.
 */
@Entity('leveling_command_permissions')
@Index('leveling_command_permissions_server_idx', ['serverId'])
export class LevelingCommandPermission {
  @PrimaryColumn({ name: 'server_id', type: 'text' })
  serverId: string;

  @PrimaryColumn({ name: 'command', type: 'text' })
  command: string;

  @Column({ name: 'mode', type: 'text' })
  mode: 'everyone' | 'admins' | 'roles';

  @Column({ name: 'allowed_role_ids', type: 'text', array: true, default: '{}' })
  allowedRoleIds: string[];

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
