import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate } from './entities/store-template.entity';

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(StoreTemplate)
    private readonly storeTemplateRepo: Repository<StoreTemplate>,
    @InjectRepository(ServerTemplate)
    private readonly serverTemplateRepo: Repository<ServerTemplate>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    @InjectRepository(UserTemplateAccess)
    private readonly accessRepo: Repository<UserTemplateAccess>,
  ) {}

  listPublicTemplates() {
    return this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where('st.isActive = true')
      .orderBy('st.createdAt', 'DESC')
      .select([
        'st.id',
        'st.templateId',
        'st.price',
        'st.currency',
        't.id',
        't.name',
        't.description',
        't.discordTemplateUrl',
        't.iconUrl',
      ])
      .getMany();
  }

  async upsertStoreTemplate(input: {
    templateId: string;
    price?: number;
    currency?: string;
    isActive?: boolean;
  }) {
    const template = await this.serverTemplateRepo.findOne({ where: { id: input.templateId } });
    if (!template) throw new NotFoundException('Template not found');
    let row = await this.storeTemplateRepo.findOne({ where: { templateId: input.templateId } });
    if (!row) row = this.storeTemplateRepo.create({ templateId: input.templateId });
    if (input.price !== undefined) row.price = input.price;
    if (input.currency !== undefined) row.currency = input.currency;
    if (input.isActive !== undefined) row.isActive = input.isActive;
    return this.storeTemplateRepo.save(row);
  }

  async checkout(userId: string, templateId: string) {
    const st = await this.storeTemplateRepo.findOne({ where: { templateId, isActive: true } });
    if (!st) throw new BadRequestException('Template is not available for purchase');

    const purchase = this.purchaseRepo.create({
      userId,
      templateId,
      amount: st.price,
      currency: st.currency,
      status: 'paid',
      provider: 'internal',
      externalPaymentId: null,
    });
    await this.purchaseRepo.save(purchase);

    const existingAccess = await this.accessRepo.findOne({ where: { userId, templateId } });
    if (!existingAccess) {
      await this.accessRepo.save(this.accessRepo.create({ userId, templateId }));
    }

    return { ok: true, purchaseId: purchase.id };
  }

  async finalizePaidPurchase(input: {
    userId: string;
    templateId: string;
    provider: string;
    externalPaymentId: string;
  }) {
    const st = await this.storeTemplateRepo.findOne({ where: { templateId: input.templateId, isActive: true } });
    if (!st) throw new BadRequestException('Template is not available for purchase');

    const existing = await this.purchaseRepo.findOne({
      where: { externalPaymentId: input.externalPaymentId },
    });
    if (existing) {
      return { ok: true, purchaseId: existing.id, alreadyProcessed: true };
    }

    const purchase = this.purchaseRepo.create({
      userId: input.userId,
      templateId: input.templateId,
      amount: st.price,
      currency: st.currency,
      status: 'paid',
      provider: input.provider,
      externalPaymentId: input.externalPaymentId,
    });
    await this.purchaseRepo.save(purchase);

    const existingAccess = await this.accessRepo.findOne({
      where: { userId: input.userId, templateId: input.templateId },
    });
    if (!existingAccess) {
      await this.accessRepo.save(this.accessRepo.create({ userId: input.userId, templateId: input.templateId }));
    }

    return { ok: true, purchaseId: purchase.id, alreadyProcessed: false };
  }

  myPurchases(userId: string) {
    return this.purchaseRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }
}

