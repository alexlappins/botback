import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type PurchaseStatus = 'paid' | 'refunded';

@Entity('purchases')
export class Purchase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ name: 'provider', type: 'varchar', length: 32, default: 'internal' })
  provider: string;

  @Column({ name: 'external_payment_id', type: 'varchar', length: 128, nullable: true, unique: true })
  externalPaymentId: string | null;

  @Column({ type: 'int', default: 0 })
  amount: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  @Column({ type: 'varchar', length: 16, default: 'paid' })
  status: PurchaseStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

