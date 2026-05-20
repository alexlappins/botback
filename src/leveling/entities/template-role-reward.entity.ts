import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Template-side mirror of {@link RoleReward}. Roles are addressed by NAME —
 * the actual Discord role id is resolved against the destination guild at
 * install time. If a role is missing on the guild, the install service
 * skips that reward and reports it in the install warnings.
 */
@Entity('template_role_rewards')
@Index(['templateId'])
@Unique('template_role_rewards_uniq', ['templateId', 'level'])
export class TemplateRoleReward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ type: 'int' })
  level: number;

  @Column({ name: 'role_name', type: 'varchar', length: 128 })
  roleName: string;
}
