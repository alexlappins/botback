import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Template-side mirror of {@link NoXpRole}. Stored by role NAME. */
@Entity('template_no_xp_roles')
@Unique('template_no_xp_roles_uniq', ['templateId', 'roleName'])
export class TemplateNoXpRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ name: 'role_name', type: 'varchar', length: 128 })
  roleName: string;
}
