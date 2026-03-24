import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServerTemplate } from '../../server-templates/entities/server-template.entity';

@Entity('store_templates')
export class StoreTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid', unique: true })
  templateId: string;

  @ManyToOne(() => ServerTemplate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  @Column({ type: 'int', default: 0 })
  price: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

