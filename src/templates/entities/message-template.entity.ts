import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('message_templates')
export class MessageTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** ID сервера Discord (гильдии) */
  @Column({ name: 'guild_id' })
  guildId: string;

  /** Название шаблона (уникально в рамках гильдии) */
  @Column()
  name: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  image: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
