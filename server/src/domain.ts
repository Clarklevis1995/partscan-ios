export type AnalysisStatus = 'queued' | 'analyzing' | 'generating' | 'completed' | 'failed';
export type QwenModel = 'qwen3.7-flash' | 'qwen3.7-plus' | 'qwen3.7-max' | 'qwen3.8-max';
export type OpenAIModel = 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna';
export type AnalysisModel = QwenModel | OpenAIModel;
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AnalysisOptions {
  reasoningEffort: ReasoningEffort;
  vlmBatchSize: number;
  multiScaleEnabled: boolean;
}

export interface PartItem {
  number: string;
  /** AI-inferred short description; the printed number remains the source of truth. */
  name?: string;
  quantity: number;
  sourcePages?: number[];
}

export interface PlateItem { code: string; parts: PartItem[] }
export interface AssemblySection {
  name: string;
  plates: PlateItem[];
  sourcePages?: number[];
}
export interface UncertainItem { description: string; suggestedAction?: string }
export interface PartsList { sections: AssemblySection[]; uncertainItems: UncertainItem[] }

export interface ProductRecord {
  id: string;
  name: string;
  coverPath?: string;
  manualPagePaths: string[];
  createdAt: string;
  updatedAt: string;
  activeAnalysisId?: string;
  partsList?: PartsList;
}

export interface AnalysisRecord {
  id: string;
  productId: string;
  model: AnalysisModel;
  useOcr: boolean;
  options: AnalysisOptions;
  status: AnalysisStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
