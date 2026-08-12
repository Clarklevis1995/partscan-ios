import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AnalysisModel, AnalysisOptions, AnalysisRecord, AnalysisStage, AnalysisStatus } from '../domain';

@Injectable()
export class AnalysisRepository {
  private readonly jobs = new Map<string, AnalysisRecord>();

  create(productId: string, model: AnalysisModel, useOcr: boolean, options: AnalysisOptions): AnalysisRecord {
    const now = new Date().toISOString();
    const job: AnalysisRecord = { id: randomUUID(), productId, model, useOcr, options, status: 'queued', stage: 'queued', progress: 5, message: '任务已进入分析队列', createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): AnalysisRecord {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('Analysis task not found');
    return job;
  }

  update(id: string, status: AnalysisStatus, progress: number, message: string, error?: string, stage?: AnalysisStage): AnalysisRecord {
    const job = this.get(id);
    Object.assign(job, { status, stage: stage ?? job.stage, progress, message, error, updatedAt: new Date().toISOString() });
    return job;
  }
}
