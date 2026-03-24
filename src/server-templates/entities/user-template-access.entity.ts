import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_template_access')
@Index(['userId', 'templateId'], { unique: true })
export class UserTemplateAccess {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @CreateDateColumn({ name: 'granted_at' })
  grantedAt: Date;
}

