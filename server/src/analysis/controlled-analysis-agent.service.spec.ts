import { ConfigService } from '@nestjs/config';
import { OpenAIProvider } from './openai.provider';
import { QwenProvider } from './qwen.provider';
import { ResultValidatorService } from './result-validator.service';
import { ControlledAnalysisAgentService } from './controlled-analysis-agent.service';

describe('ControlledAnalysisAgentService assembly plan', () => {
  it('uses the planned unit name and deterministically applies x2', () => {
    const config = new ConfigService({ QWEN_MOCK: 'true' });
    const agent = new ControlledAnalysisAgentService(new QwenProvider(config), new OpenAIProvider(config), new ResultValidatorService());
    const apply = (agent as unknown as { applyAssemblyPlan: (result: any, inventory: any[]) => any }).applyAssemblyPlan.bind(agent);
    const result = apply({ sections: [{ unitId: 'step-3-arms', name: '头部', plates: [{ code: 'C1', parts: [{ number: '18', quantity: 1 }] }] }], uncertainItems: [] }, [{
      page: 2, role: 'assembly_steps', plateDictionary: ['C1'], labels: [], assemblyUnits: [{ unitId: 'step-3-arms', name: '肩甲/手臂', stepNumber: '3', multiplier: 2, startPage: 2, startReadingOrder: 10 }],
    }]);
    expect(result.sections[0]).toMatchObject({ name: '肩甲/手臂', multiplier: 2 });
    expect(result.sections[0].plates[0].parts[0].quantity).toBe(2);
  });
});
