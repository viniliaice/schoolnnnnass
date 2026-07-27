# AI Lesson Plan Review

How the AI-powered lesson plan review system works, from submission to scoring.

## The problem

Supervisors can't review every lesson plan in detail. Teachers submit weekly plans, and manual review is time-consuming. The system needs automated quality feedback that's consistent and actionable.

## The approach

### Architecture

```
Teacher submits plan
  → Client sends periods to edge function
  → Edge function calls LLM (GPT-4 or similar)
  → LLM returns structured JSON scores
  → Edge function saves to ai_reviews table
  → Supervisor sees AI scores + adds their own review
```

### The edge function

Located in `supabase/functions/review-lesson-plan/`, the edge function:

1. Receives the plan's periods as JSON
2. Constructs a system prompt with scoring criteria
3. Calls the LLM API
4. Parses the structured JSON response
5. Saves the review to the database

### Scoring categories

The AI evaluates 10 categories, each scored 0-100:

| Category | Weight | What it measures |
|----------|--------|-----------------|
| Learning Objectives | High | Are objectives specific, measurable, achievable? |
| Lesson Structure | High | Does the lesson flow logically? Are transitions smooth? |
| Student Engagement | Medium | Are there active learning opportunities? |
| Teaching Strategies | Medium | Is there variety in instruction methods? |
| Differentiation | Medium | Are there adaptations for different learners? |
| Assessment Methods | High | How is student learning checked? |
| Curriculum Alignment | High | Does it match expected standards? |
| Classroom Management | Low | Are behavior and time management addressed? |
| Resources Materials | Low | Are materials appropriate and available? |
| Overall Quality | High | Holistic assessment of the plan |

### The prompt structure

The system prompt asks the LLM to:

1. Read each period's topic, objective, and activities
2. Score each category on a 0-100 scale
3. Provide an explanation for each score
4. List strengths and improvement areas
5. Write an executive summary
6. Recommend a status (approve/revise/reject)

### Response format

The LLM returns structured JSON:

```json
{
  "category_scores": {
    "learning_objectives": { "score": 85, "explanation": "..." },
    "lesson_structure": { "score": 78, "explanation": "..." }
  },
  "total_score": 79,
  "percentage": 79,
  "performance_level": "good",
  "strengths": ["Clear objectives", "Varied activities"],
  "improvements": [
    { "area": "Assessment", "why": "...", "recommendation": "..." }
  ]
}
```

### Performance levels

| Percentage | Level | Action |
|-----------|-------|--------|
| 90-100 | Excellent | Approve |
| 80-89 | Very Good | Approve with minor notes |
| 70-79 | Good | Approve or revise |
| 60-69 | Needs Improvement | Revise |
| 0-59 | Requires Significant Revision | Reject |

### Supervisor workflow

1. AI review is saved automatically on submission
2. Supervisor opens the plan and sees AI scores
3. Supervisor reads the AI's executive summary
4. Supervisor adds their own comment
5. Supervisor approves or requests revision

The AI doesn't replace the supervisor — it provides consistent, structured feedback that speeds up the review.

## Why this design

**Edge function over client-side:** The LLM API key stays server-side. The edge function handles retries, timeouts, and error formatting.

**Structured JSON over free text:** Structured output enables:
- Consistent scoring across plans
- Trend tracking over time
- Comparison between teachers
- Automated status recommendations

**10 categories over a single score:** Granular feedback helps teachers improve specific areas. A single "79/100" doesn't tell them what to fix.

## Trade-offs

**What was gained:**
- Consistent, automated quality feedback
- Scalable review process
- Data-driven improvement tracking
- Supervisor time savings

**What was given up:**
- LLM cost per review (typically $0.01-0.05)
- Dependency on external API availability
- Potential for biased scoring (mitigated by structured criteria)
- Real-time review (takes 10-30 seconds)

## Alternatives considered

**Rule-based scoring:** Would be free and instant but too rigid. Lesson plans are creative — rules can't capture quality nuance.

**Peer review:** Teachers reviewing each other's plans. Good for culture but doesn't scale and introduces social dynamics.

**Supervisor-only review:** The status quo. Works but doesn't scale — supervisors become bottlenecks.
