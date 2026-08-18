import { describe, expect, it } from 'vitest';
import { validateGeneratedQuiz, validateGeneratedResponse } from '../quizGenerationValidation';

function makeQualityResponse(): any {
  return {
    quizzes: Array.from({ length: 3 }, (_, quizIndex) => ({
      title: `Plant Knowledge Check ${quizIndex + 1}`,
      questions: Array.from({ length: 4 }, (_, questionIndex) => questionIndex === 3
        ? {
            type: 'direct_answer' as const,
            question: `Explain one way plant process ${quizIndex + 1} supports growth.`,
            rubric: `Award credit for an accurate explanation of plant process ${quizIndex + 1}.`,
          }
        : {
            type: 'multiple_choice' as const,
            question: `Which statement correctly describes plant idea ${quizIndex + 1}-${questionIndex + 1}?`,
            options: ['A', 'B', 'C', 'D'].map((label) => `Plant idea ${quizIndex + 1}-${questionIndex + 1}-${label}`),
            correctIndex: questionIndex,
          }),
    })),
  };
}

function cloneQualityResponse() {
  return structuredClone(makeQualityResponse());
}

describe('lesson plan quiz generation validation', () => {
  const validQuiz = {
    title: 'Grade 2 Addition Quiz',
    questions: [
      {
        type: 'multiple_choice' as const,
        question: 'Muna has 24 pencils and gets 18 more. Which sum should she solve?',
        options: ['24 + 18', '24 - 18', '18 - 24', '24 + 8'],
        correctIndex: 0,
        explanation: 'The problem asks for a total, so addition is required.',
      },
      {
        type: 'multiple_choice' as const,
        question: 'Which step helps when adding 37 + 25 with regrouping?',
        options: ['Add ones first and regroup ten ones', 'Subtract the tens', 'Ignore the ones', 'Write only 37'],
        correctIndex: 0,
        explanation: 'Regrouping happens after combining the ones.',
      },
      {
        type: 'multiple_choice' as const,
        question: 'What is 46 + 28?',
        options: ['74', '64', '68', '84'],
        correctIndex: 0,
        explanation: 'Adding the ones and tens with regrouping gives 74.',
      },
      {
        type: 'direct_answer' as const,
        question: 'Explain how to solve 46 + 28 using regrouping.',
        options: null,
        correctIndex: null,
        rubric: 'A correct answer adds ones, regroups 14 ones as 1 ten and 4 ones, then adds tens to get 74.',
      },
    ],
  };

  it('accepts exactly three multiple-choice questions followed by one direct answer', () => {
    expect(validateGeneratedQuiz(validQuiz)).toBe(validQuiz);
  });

  it('rejects otherwise valid questions in the wrong type order', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        validQuiz.questions[0],
        validQuiz.questions[1],
        validQuiz.questions[3],
        validQuiz.questions[2],
      ],
    })).toThrow(/invalid type or position/i);
  });

  it('rejects direct-answer questions with options', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        validQuiz.questions[0],
        validQuiz.questions[1],
        validQuiz.questions[2],
        { ...validQuiz.questions[3], options: ['A', 'B'] },
      ],
    })).toThrow(/must not have options/i);
  });

  it('rejects direct-answer questions without a rubric', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        validQuiz.questions[0],
        validQuiz.questions[1],
        validQuiz.questions[2],
        { ...validQuiz.questions[3], rubric: '' },
      ],
    })).toThrow(/must have a rubric/i);
  });

  it('rejects multiple-choice questions without exactly four unique options', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        { ...validQuiz.questions[0], options: ['A', 'A', 'B', 'C'] },
        validQuiz.questions[1],
        validQuiz.questions[2],
        validQuiz.questions[3],
      ],
    })).toThrow(/options are not distinct/i);
  });

  it('accepts a complete varied 3×4 response', () => {
    expect(validateGeneratedResponse(makeQualityResponse())).toHaveLength(3);
  });

  it('rejects teacher, resource, planning, and administration questions', () => {
    for (const forbiddenQuestion of [
      'Which worksheet page should the teacher assign?',
      'What was the warm-up activity in the lesson?',
      'How many minutes did the class activity take?',
      'Which database ID identifies this learning objective?',
    ]) {
      const response = cloneQualityResponse();
      response.quizzes[0].questions[0].question = forbiddenQuestion;
      expect(() => validateGeneratedResponse(response)).toThrow(/teacher delivery, resources, or lesson planning/i);
    }
  });

  it('permits otherwise forbidden terminology only when the matching objective states it', () => {
    const response = cloneQualityResponse();
    response.quizzes[0].questions[0].question = 'Which chart correctly represents the plant data?';

    expect(() => validateGeneratedResponse(response)).toThrow(/teacher delivery, resources, or lesson planning/i);
    expect(() => validateGeneratedResponse(response, {
      learningObjectives: ['Interpret plant data shown in a chart'],
    })).not.toThrow();
    expect(() => validateGeneratedResponse(response, {
      learningObjectives: ['Use a worksheet to practise plant vocabulary'],
    })).toThrow(/teacher delivery, resources, or lesson planning/i);
  });

  it('rejects placeholders, truncation, duplicate stems, and repeated answer sets', () => {
    const placeholder = cloneQualityResponse();
    placeholder.quizzes[0].questions[0].question = 'Question 1: [insert question here]';
    expect(() => validateGeneratedResponse(placeholder)).toThrow(/placeholder or truncated/i);

    const truncated = cloneQualityResponse();
    truncated.quizzes[0].questions[0].options![2] = 'The plant uses...';
    expect(() => validateGeneratedResponse(truncated)).toThrow(/placeholder or truncated/i);

    const duplicateStem = cloneQualityResponse();
    duplicateStem.quizzes[1].questions[0].question = duplicateStem.quizzes[0].questions[0].question;
    expect(() => validateGeneratedResponse(duplicateStem)).toThrow(/duplicates a question/i);

    const repeatedOptions = cloneQualityResponse();
    repeatedOptions.quizzes[1].questions[0].options = [...repeatedOptions.quizzes[0].questions[0].options!];
    expect(() => validateGeneratedResponse(repeatedOptions)).toThrow(/repeats an answer set/i);
  });

  it('solves parseable arithmetic and verifies the unique answer and correctIndex', () => {
    const valid = cloneQualityResponse();
    valid.quizzes[0].questions[0] = {
      type: 'multiple_choice',
      question: 'What is 27 + 16?',
      options: ['42', '43', '44', '53'],
      correctIndex: 1,
    };
    expect(() => validateGeneratedResponse(valid)).not.toThrow();

    const wrongIndex = structuredClone(valid);
    wrongIndex.quizzes[0].questions[0].correctIndex = 0;
    expect(() => validateGeneratedResponse(wrongIndex)).toThrow(/correctIndex does not match/i);

    const missingAnswer = structuredClone(valid);
    missingAnswer.quizzes[0].questions[0].options = ['39', '42', '44', '53'];
    expect(() => validateGeneratedResponse(missingAnswer)).toThrow(/exactly one solved arithmetic answer/i);

    const wrongRubric = cloneQualityResponse();
    wrongRubric.quizzes[0].questions[3] = {
      type: 'direct_answer',
      question: 'Calculate 18 ÷ 3.',
      rubric: 'Award credit for showing a valid division method.',
    };
    expect(() => validateGeneratedResponse(wrongRubric)).toThrow(/rubric does not include the solved arithmetic answer/i);
    wrongRubric.quizzes[0].questions[3].rubric = 'Award credit for the checked result 6.';
    expect(() => validateGeneratedResponse(wrongRubric)).not.toThrow();
  });

  it('rejects malformed, mixed-type, and duplicate numeric distractors', () => {
    const malformed = cloneQualityResponse();
    malformed.quizzes[0].questions[0] = {
      type: 'multiple_choice',
      question: 'What is 8 + 5?',
      options: ['13', '12', 'fourteen', '15'],
      correctIndex: 0,
    };
    expect(() => validateGeneratedResponse(malformed)).toThrow(/malformed numeric distractors/i);

    const mixedTypes = cloneQualityResponse();
    mixedTypes.quizzes[0].questions[0] = {
      type: 'multiple_choice',
      question: 'Which value is the answer?',
      options: ['13%', '12%', '14', '15%'],
      correctIndex: 0,
    };
    expect(() => validateGeneratedResponse(mixedTypes)).toThrow(/same value type/i);

    const duplicateValues = cloneQualityResponse();
    duplicateValues.quizzes[0].questions[0] = {
      type: 'multiple_choice',
      question: 'Which value is greatest?',
      options: ['13', '13.0', '14', '15'],
      correctIndex: 3,
    };
    expect(() => validateGeneratedResponse(duplicateValues)).toThrow(/duplicate numeric answer values/i);
  });
});
