import { GoogleGenAI, Type } from "@google/genai";
import { UserPreferences, ComparisonResponse, DynamicParameter, DecisionCategory } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Robustly extracts JSON from a model response.
 */
function extractJSON(text: string): any {
  if (!text) return {};
  
  let cleaned = text.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    cleaned = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const startObj = cleaned.indexOf('{');
    const endObj = cleaned.lastIndexOf('}');
    const startArr = cleaned.indexOf('[');
    const endArr = cleaned.lastIndexOf(']');

    let jsonContent = '';
    if (startObj !== -1 && endObj !== -1 && (startArr === -1 || startObj < startArr)) {
      jsonContent = cleaned.substring(startObj, endObj + 1);
    } else if (startArr !== -1 && endArr !== -1) {
      jsonContent = cleaned.substring(startArr, endArr + 1);
    }

    if (!jsonContent) return {};

    try {
      return JSON.parse(jsonContent);
    } catch (innerError) {
      return {};
    }
  }
}

const parameterGenerationSchema = {
  type: Type.OBJECT,
  properties: {
    parameters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          label: { type: Type.STRING },
          type: { type: Type.STRING },
          min: { type: Type.NUMBER },
          max: { type: Type.NUMBER },
          unit: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          reason: { type: Type.STRING },
          defaultValue: { type: Type.STRING },
        },
        required: ['id', 'name', 'label', 'type', 'reason'],
      },
    },
    suggestedPriorities: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    }
  },
  required: ['parameters', 'suggestedPriorities'],
};

const comparisonSchema = {
  type: Type.OBJECT,
  properties: {
    options: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          overview: { type: Type.STRING },
          pros: { type: Type.ARRAY, items: { type: Type.STRING } },
          cons: { type: Type.ARRAY, items: { type: Type.STRING } },
          best_for: { type: Type.STRING },
          risks: { type: Type.ARRAY, items: { type: Type.STRING } },
          cost_level: { type: Type.STRING },
          complexity: { type: Type.STRING },
          scores: {
            type: Type.OBJECT,
            properties: {
              suitability: { type: Type.INTEGER },
              risk: { type: Type.INTEGER },
              cost: { type: Type.INTEGER },
              scalability: { type: Type.INTEGER },
            },
            required: ["suitability", "risk", "cost", "scalability"],
          },
        },
        required: ["name", "overview", "pros", "cons", "best_for", "risks", "cost_level", "complexity", "scores"],
      },
    },
    summary: { type: Type.STRING },
    recommendation: { type: Type.STRING },
  },
  required: ["options", "summary", "recommendation"],
};

export async function getDynamicParameters(category: DecisionCategory, problemStatement: string): Promise<{ parameters: DynamicParameter[], suggestedPriorities: string[] }> {
  const prompt = `
    Analyze this decision intent:
    Category: ${category}
    Problem: "${problemStatement}"
    
    Identify 4-6 key parameters. Use standard numeric ranges (e.g., 0-100 or specific units like USD where relevant).
    Available types: 'slider', 'toggle', 'select'.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: parameterGenerationSchema,
        systemInstruction: "You are The Referee. Provide strictly valid JSON following the schema. Be precise and objective.",
      },
    });

    const data = extractJSON(response.text);
    
    return {
      parameters: (data.parameters || []).map((p: any) => ({
        ...p,
        value: p.type === 'slider' ? (p.defaultValue ? Number(p.defaultValue) : ((p.min || 0) + (p.max || 100)) / 2) : p.type === 'toggle' ? false : p.defaultValue || ''
      })) as DynamicParameter[],
      suggestedPriorities: (data.suggestedPriorities || []) as string[]
    };
  } catch (error) {
    console.error("Setup Analysis Error:", error);
    return {
      parameters: [
        { id: 'cost', name: 'cost', label: 'Importance of Cost', type: 'slider', min: 0, max: 100, value: 50, reason: 'Budget is often a key factor.' },
        { id: 'risk', name: 'risk', label: 'Risk Tolerance', type: 'slider', min: 0, max: 100, value: 30, reason: 'Helps balance safety vs innovation.' }
      ] as DynamicParameter[],
      suggestedPriorities: ['Cost Efficiency', 'Reliability', 'Speed', 'Scalability']
    };
  }
}

export async function compareOptions(prefs: UserPreferences): Promise<ComparisonResponse> {
  const paramSummary = prefs.dynamicParams
    .map(p => `- ${p.label}: ${p.value} ${p.unit || ''}`)
    .join("\n");

  const prompt = `
    Dilemma: "${prefs.problemStatement}"
    Category: "${prefs.category}"
    Constraints:
    ${paramSummary}
    Priorities: ${prefs.priorities.join(", ")}

    Identify and score 2-3 distinct, viable options. Provide a clear recommendation.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: comparisonSchema,
        maxOutputTokens: 4000,
        thinkingConfig: { thinkingBudget: 1500 },
        systemInstruction: "You are The Referee, a neutral decision analyst. Return strictly valid JSON.",
      },
    });

    const data = extractJSON(response.text);
    
    return {
      options: (data.options || []).map((opt: any) => ({
        ...opt,
        name: opt.name || "Option",
        overview: opt.overview || "Path analyzed based on your requirements.",
        scores: opt.scores || { suitability: 50, risk: 50, cost: 50, scalability: 50 }
      })),
      summary: data.summary || "The Referee has analyzed your options.",
      recommendation: data.recommendation || "Consider the trade-offs above to make your choice.",
    };
  } catch (error) {
    console.error("Comparison Analysis Error:", error);
    throw error;
  }
}