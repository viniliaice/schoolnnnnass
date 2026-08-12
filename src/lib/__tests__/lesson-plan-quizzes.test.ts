import { describe, expect, it } from 'vitest';
import { validateGeneratedQuiz } from '../quizGenerationValidation';

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
        type: 'direct_answer' as const,
        question: 'Explain how to solve 46 + 28 using regrouping.',
        options: null,
        correctIndex: null,
        rubric: 'A correct answer adds ones, regroups 14 ones as 1 ten and 4 ones, then adds tens to get 74.',
      },
      {
        type: 'multiple_choice' as const,
        question: 'What is 46 + 28?',
        options: ['74', '64', '68', '84'],
        correctIndex: 0,
        explanation: 'Adding the ones and tens with regrouping gives 74.',
      },
    ],
  };

  it('accepts a mixed quiz with multiple-choice and direct-answer questions', () => {
    expect(validateGeneratedQuiz(validQuiz)).toBe(validQuiz);
  });

  it('rejects direct-answer questions with options', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        validQuiz.questions[0],
        validQuiz.questions[1],
        { ...validQuiz.questions[2], options: ['A', 'B'] },
        validQuiz.questions[3],
      ],
    })).toThrow(/must not have options/i);
  });

  it('rejects direct-answer questions without a rubric', () => {
    expect(() => validateGeneratedQuiz({
      ...validQuiz,
      questions: [
        validQuiz.questions[0],
        validQuiz.questions[1],
        { ...validQuiz.questions[2], rubric: '' },
        validQuiz.questions[3],
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
});
