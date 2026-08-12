export type AnalysisStatus = 'queued' | 'analyzing' | 'generating' | 'completed' | 'failed';
export type AnalysisStage = 'queued' | 'preparing' | 'inventory' | 'extracting' | 'validating' | 'reviewing' | 'reconciling' | 'generating' | 'completed' | 'failed';
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
  /** Stable id from the visual assembly-unit planner. Prevents cross-part merging. */
  unitId?: string;
  name: string;
  multiplier?: number;
  plates: PlateItem[];
  sourcePages?: number[];
}
export interface UncertainItem { description: string; suggestedAction?: string }
export interface PartsList { sections: AssemblySection[]; uncertainItems: UncertainItem[] }
export type ManualPageCaptureHint = 'plate_catalog' | 'assembly_steps' | 'unknown';
export type ManualPageRole = 'plate_catalog' | 'assembly_steps' | 'other';
export interface InventoryLabel {
  plateCode: string;
  partNumber: string;
  parenthesized: boolean;
  unitId: string;
  readingOrder: number;
}
export interface AssemblyUnitPlan {
  unitId: string;
  name: string;
  stepNumber: string;
  multiplier: number;
  startPage: number;
  startReadingOrder: number;
}
export interface PageInventory {
  page: number;
  role: ManualPageRole;
  plateDictionary: string[];
  assemblyUnits: AssemblyUnitPlan[];
  labels: InventoryLabel[];
}

export interface ProductRecord {
  id: string;
  name: string;
  coverPath?: string;
  manualPagePaths: string[];
  manualPageHints: ManualPageCaptureHint[];
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
  stage: AnalysisStage;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
