import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';

const NUMBER = /^[+-]?(?:\p{Number}+(?:\.\p{Number}*)?|\.\p{Number}+)(?:[eE][+-]?\p{Number}+)?$/u;
const NUMBER_CONTEXT = /(?:^|[^\p{Alphabetic}\p{Number}_$])[+-]?(?:\p{Number}+(?:\.\p{Number}*)?|\.\p{Number}+)(?:[eE][+-]?\p{Number}*)?$/u;

function numericContext(context: CompletionContext): boolean {
  return context.matchBefore(NUMBER_CONTEXT) !== null;
}

function filterResult(result: CompletionResult | null): CompletionResult | null {
  if (!result) return null;
  const options = result.options.filter(option => !NUMBER.test(option.label));
  if (!options.length) return null;
  const { validFor, update } = result;
  const validPattern = validFor && typeof validFor !== 'function'
    ? new RegExp(`^(?:${validFor.source})$`, validFor.flags.replace(/[gy]/g, '')) : null;
  return {
    ...result,
    options,
    validFor: validFor ? (text, from, to, state) => {
      if (numericContext(new CompletionContext(state, to, false))) return false;
      return typeof validFor === 'function' ? validFor(text, from, to, state) : validPattern!.test(text);
    } : undefined,
    update: update ? (current, from, to, context) => numericContext(context)
      ? null : filterResult(update(current, from, to, context)) : undefined,
  };
}

export function nonNumericCompletion(source: CompletionSource): CompletionSource {
  return context => {
    if (numericContext(context)) return null;
    const result = source(context);
    return result && 'then' in result ? result.then(filterResult) : filterResult(result);
  };
}
