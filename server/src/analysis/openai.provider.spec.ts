import { ConfigService } from '@nestjs/config';
import { OpenAIProvider } from './openai.provider';

describe('OpenAIProvider', () => {
  it('supports the OpenAI multimodal model picker in mock mode', async () => {
    const provider = new OpenAIProvider(new ConfigService({ QWEN_MOCK: 'true' }));
    const result = await provider.analyze([], 'gpt-5.6-sol');
    expect(result.sections[0].plates[0].parts[0]).toMatchObject({ number: '1', quantity: 1 });
  });
});
