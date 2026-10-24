export const PROVIDER_ALIASES = {
  'start-plan': 'account:bigmodel-start-plan',
  bigmodel: 'account:bigmodel-individual-coding-plan',
}

export const MODEL_GUIDANCE = {
  'GLM-5.3': { vision: false, guidance: 'Stronger reasoning and coding; text only.' },
  'GLM-5.3-Flash': { vision: true, guidance: 'Vision capable; weaker overall than GLM-5.3.' },
  connectorInput: 'text-only; image paths are not uploaded as attachments',
}

export function resolveModelSelection(providers, current, options) {
  const requestedProvider = options.provider ?? current.provider
  const providerId = PROVIDER_ALIASES[requestedProvider] ?? requestedProvider
  const provider = providers.find(entry => entry.id === providerId)
  if (!provider) throw new Error(`ZCode provider is unavailable: ${requestedProvider}`)
  const modelId = options.model ?? current.model
  const model = provider.models.find(entry => entry.id === modelId)
  if (!model) throw new Error(`ZCode model is unavailable in ${provider.label}: ${modelId}`)
  return { provider: provider.id, providerKey: provider.key, model: model.id, modelValue: model.value, effort: options.effort ?? 'max' }
}
