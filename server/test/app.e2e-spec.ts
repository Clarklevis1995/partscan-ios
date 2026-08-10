import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request = require('supertest');
import { AppModule } from '../src/app.module';

describe('PartScan API (e2e)', () => {
  let app: INestApplication;
  let storageDirectory: string;

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), 'partscan-api-test-'));
    process.env.STORAGE_DIR = storageDirectory;
    process.env.QWEN_MOCK = 'true';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (storageDirectory.startsWith(`${tmpdir()}/partscan-api-test-`)) await rm(storageDirectory, { recursive: true, force: true });
  });

  it('advertises Flash, Plus and Max and rejects unsupported models', async () => {
    await request(app.getHttpServer()).get('/v1/analysis/models').expect(200).expect(({ body }) => {
      expect(body.map((model: { id: string }) => model.id)).toEqual([
        'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.8-max',
        'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      ]);
    });
    await request(app.getHttpServer())
      .post('/v1/products/not-used/analysis')
      .send({ model: 'qwen3.6-plus' })
      .expect(400);
  });

  it('exposes the OCR test upload endpoint and validates the image field', async () => {
    await request(app.getHttpServer()).post('/v1/testing/ocr').expect(400).expect(({ body }) => {
      expect(body.message).toContain('image');
    });
    await request(app.getHttpServer()).post('/v1/testing/ocr?provider=tencent').expect(400).expect(({ body }) => {
      expect(body.message).toContain('image');
    });
    await request(app.getHttpServer()).post('/v1/testing/ocr?provider=unknown').expect(400).expect(({ body }) => {
      expect(body.message).toContain('provider');
    });
  });

  it('creates a product, uploads pages, analyzes, retains pages, and allows manual deletion', async () => {
    const created = await request(app.getHttpServer()).post('/v1/products').field('name', '测试模型').expect(201);
    expect(created.body).toMatchObject({
      name: '测试模型',
      hasCover: false,
      manualPageCount: 0,
      hasPartsList: false,
    });
    expect(created.body).not.toHaveProperty('manualPagePaths');
    expect(created.body).not.toHaveProperty('coverPath');
    const productId = created.body.id as string;

    await request(app.getHttpServer())
      .post(`/v1/products/${productId}/manual-pages`)
      .attach('pages', Buffer.from('mock image'), { filename: 'page-1.jpg', contentType: 'image/jpeg' })
      .expect(201)
      .expect(({ body }) => expect(body.manualPageCount).toBe(1));

    const started = await request(app.getHttpServer())
      .post(`/v1/products/${productId}/analysis`)
      .send({ model: 'qwen3.7-plus', useOcr: false })
      .expect(201);
    expect(started.body.model).toBe('qwen3.7-plus');
    expect(started.body.useOcr).toBe(false);
    const analysisId = started.body.id as string;

    await new Promise((resolve) => setTimeout(resolve, 80));
    await request(app.getHttpServer()).get(`/v1/analysis/${analysisId}`).expect(200).expect(({ body }) => expect(body.status).toBe('completed'));
    await request(app.getHttpServer()).get(`/v1/products/${productId}/parts-list`).expect(200).expect(({ body }) => {
      expect(body.sections[0].plates[0].code).toBe('A1');
      expect(body.sections[0].plates[0].parts[0].name).toBe('连接件');
      expect(body.sections[0]).not.toHaveProperty('confidence');
      expect(body.sections[0].plates[0].parts[0]).not.toHaveProperty('confidence');
    });
    await request(app.getHttpServer()).get(`/v1/products/${productId}`).expect(200).expect(({ body }) => expect(body.manualPageCount).toBe(1));
    const openaiStarted = await request(app.getHttpServer())
      .post(`/v1/products/${productId}/analysis`)
      .send({ model: 'gpt-5.6-sol', useOcr: false, reasoningEffort: 'high', vlmBatchSize: 2, multiScaleEnabled: false })
      .expect(201);
    expect(openaiStarted.body).toMatchObject({
      model: 'gpt-5.6-sol',
      useOcr: false,
      options: { reasoningEffort: 'high', vlmBatchSize: 2, multiScaleEnabled: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await request(app.getHttpServer()).get(`/v1/analysis/${openaiStarted.body.id}`).expect(200).expect(({ body }) => expect(body.status).toBe('completed'));
    await request(app.getHttpServer()).get(`/v1/products/${productId}/parts-list`).expect(200).expect(({ body }) => {
      expect(body.sections[0].plates[0].parts[0].number).toBe('1');
    });
    await request(app.getHttpServer()).delete(`/v1/products/${productId}/manual-cache`).expect(200).expect({ productId, cleared: true });
    await request(app.getHttpServer()).get(`/v1/products/${productId}`).expect(200).expect(({ body }) => expect(body.manualPageCount).toBe(0));
  });
});
