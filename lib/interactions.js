export function validateInteractionAnswer(request, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('answer must be an object')
  const payload = request.payload
  if (payload.kind === 'permission') {
    const options = [...payload.options, ...(payload.fullAccessOption ? [payload.fullAccessOption] : [])]
    if (!options.some(option => option.optionId === answer.optionId)) throw new Error('Choose an exact permission optionId from the pending request')
    if (Object.keys(answer).some(key => !['optionId', 'freeText', 'content'].includes(key))) throw new Error('Unexpected permission answer field')
    if (answer.freeText !== undefined && (!payload.freeText || typeof answer.freeText !== 'string')) throw new Error('Free text is not allowed for this permission')
    return
  }
  if (payload.kind !== 'userInput') throw new Error('Workspace hook trust must be reviewed directly in ZCode')
  if (payload.questions?.length) {
    if (!['accept', 'decline', 'cancel'].includes(answer.action)) throw new Error('Question answer action must be accept, decline or cancel')
    if (Object.keys(answer).some(key => !['action', 'content'].includes(key))) throw new Error('Unexpected question answer field')
    if (answer.action === 'accept') {
      const answers = answer.content?.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Provide content.answers keyed by question text')
      for (const question of payload.questions) {
        if (typeof answers[question.question] !== 'string' || !answers[question.question].trim()) throw new Error(`Missing answer: ${question.question}`)
      }
    }
  } else {
    if (Object.keys(answer).some(key => !['optionId', 'freeText'].includes(key))) throw new Error('Unexpected input answer field')
    if (answer.optionId !== undefined && payload.options?.some(option => option.optionId === answer.optionId) && answer.freeText === undefined) return
    if (payload.freeText && typeof answer.freeText === 'string' && answer.freeText.trim() && answer.optionId === undefined) return
    throw new Error('Provide one valid optionId or permitted freeText')
  }
}
