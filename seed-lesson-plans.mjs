import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://qopeilyvkfqbjdeudwnz.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvcGVpbHl2a2ZxYmpkZXVkd256Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTk4OTQsImV4cCI6MjA4OTQ3NTg5NH0.H5V6S1DWl50U7RMwwZn8gs6tVmEPDULNhhMJkA8fTcE'
);

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

const DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];

const plans = [
  // Plan 1: Bushra Cabdi — KG-A Math
  {
    teacher_id: 'teacher-1774801632044-4vd2ly',
    class_name: 'KG-A',
    title: 'Week 32 - KG-A - Number Recognition 1-20',
    status: 'in_review',
    subject_id: 'subject-1774800978713-dmnf9s',
    periods: [
      { day: 'Saturday',   period_number: 1, topic: 'Counting 1-10',        objective: 'Students will count objects from 1-10',            slide_number: '5',  activities: '1. Count aloud together (5min) [Chart] @Classroom | 2. Count beads activity (10min) [Beads] @Desks | 3. Worksheet (10min) [Worksheet] @Desks' },
      { day: 'Saturday',   period_number: 2, topic: 'Number tracing 1-5',    objective: 'Students will trace numbers 1-5 correctly',          slide_number: '6',  activities: '1. Tracing demo (5min) [Board] @Classroom | 2. Tracing practice (10min) [Workbook] @Desks | 3. Pair check (5min) [] @Desks' },
      { day: 'Saturday',   period_number: 3, topic: 'More and less',         objective: 'Compare groups as more or less',                    slide_number: '7',  activities: '1. Group comparison game (10min) [Blocks] @Carpet | 2. Circle more/less (10min) [Worksheet] @Desks' },
      { day: 'Saturday',   period_number: 4, topic: 'Free Period',           is_free: true },
      { day: 'Saturday',   period_number: 5, topic: 'Number matching game',  objective: 'Match numerals to quantities',                      slide_number: '8',  activities: '1. Card matching game (15min) [Number cards] @Centers | 2. Color by number (10min) [Crayons] @Desks' },
      { day: 'Sunday',     period_number: 1, topic: 'Counting 11-15',        objective: 'Count and recognize numbers 11-15',                 slide_number: '9',  activities: '1. Song counting (5min) [Audio] @Classroom | 2. Counting objects (10min) [Counters] @Desks | 3. Number hunt (10min) [] @Classroom' },
      { day: 'Sunday',     period_number: 2, topic: 'Number tracing 6-10',   objective: 'Trace numbers 6-10 with proper formation',          slide_number: '10', activities: '1. Sky writing (5min) [] @Classroom | 2. Tracing sheet (10min) [Pencil] @Desks | 3. Rainbow write (10min) [Crayons] @Desks' },
      { day: 'Sunday',     period_number: 3, topic: 'Free Period',           is_free: true },
      { day: 'Sunday',     period_number: 4, topic: 'Number sequencing',     objective: 'Arrange numbers 1-10 in correct order',             slide_number: '11', activities: '1. Number line walk (10min) [Tape numbers] @Floor | 2. Cut and paste (10min) [Scissors] @Desks | 3. Oral quiz (5min) [] @Carpet' },
      { day: 'Sunday',     period_number: 5, topic: 'Counting 16-20',        objective: 'Count from 16-20 with one-to-one correspondence',    slide_number: '12', activities: '1. Count around circle (5min) [] @Carpet | 2. Count and clip (15min) [Clothespins] @Centers | 3. Exit ticket (5min) [] @Desks' },
      { day: 'Monday',     period_number: 1, topic: 'Number review 1-20',    objective: 'Review all numbers 1-20',                            slide_number: '13', activities: '1. Number flash cards (5min) [Flashcards] @Carpet | 2. Bingo game (15min) [Bingo cards] @Desks | 3. Number book (10min) [Booklet] @Desks' },
      { day: 'Monday',     period_number: 2, topic: 'Counting objects',      objective: 'Count objects up to 20 accurately',                 slide_number: '14', activities: '1. Count the room (15min) [Clipboard] @Classroom | 2. Count jar items (10min) [Jars] @Science table' },
      { day: 'Monday',     period_number: 3, topic: 'Number formation',      objective: 'Write numbers 1-10 independently',                  slide_number: '15', activities: '1. Sand writing (10min) [Sand tray] @Sensory | 2. Whiteboard practice (10min) [Whiteboards] @Desks' },
      { day: 'Monday',     period_number: 4, topic: 'Free Period',           is_free: true },
      { day: 'Monday',     period_number: 5, topic: 'Counting songs review',  objective: 'Reinforce counting through songs and movement',     slide_number: '16', activities: '1. Five little monkeys (5min) [Song] @Carpet | 2. Count and hop (10min) [] @Outdoor | 3. Number dance (10min) [Music] @Classroom' },
      { day: 'Tuesday',    period_number: 1, topic: 'Before and after',      objective: 'Identify numbers before and after a given number',   slide_number: '17', activities: '1. Number line practice (10min) [] @Classroom | 2. Before/after worksheet (10min) [Worksheet] @Desks' },
      { day: 'Tuesday',    period_number: 2, topic: 'One more one less',     objective: 'Find one more and one less up to 20',                slide_number: '18', activities: '1. Dice game (10min) [Dice] @Tables | 2. One more/less sheet (10min) [Sheet] @Desks | 3. Quick assessment (5min) [] @Desks' },
      { day: 'Tuesday',    period_number: 3, topic: 'Number patterns',       objective: 'Recognize simple number patterns',                  slide_number: '19', activities: '1. Pattern blocks (10min) [Blocks] @Carpet | 2. Color pattern sheet (10min) [Crayons] @Desks' },
      { day: 'Tuesday',    period_number: 4, topic: 'Free Period',           is_free: true },
      { day: 'Tuesday',    period_number: 5, topic: 'Count and write quiz',  objective: 'Assess counting and writing numbers 1-20',           slide_number: '20', activities: '1. Quick quiz (10min) [Quiz sheet] @Desks | 2. Free counting play (10min) [Math toys] @Centers' },
      { day: 'Wednesday',  period_number: 1, topic: 'Number word one-five',  objective: 'Recognize number words one to five',                slide_number: '21', activities: '1. Word cards matching (10min) [Word cards] @Carpet | 2. Trace word sheet (10min) [Sheet] @Desks' },
      { day: 'Wednesday',  period_number: 2, topic: 'Number stations',       objective: 'Apply number skills at different stations',          slide_number: '22', activities: '1. Station rotation (20min) [Various] @Centers | 2. Reflection (5min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 3, topic: 'Weekly review',         objective: 'Review all week concepts',                           slide_number: '23', activities: '1. Class discussion (5min) [] @Carpet | 2. Review game (15min) [Ball] @Classroom | 3. Sticker chart (5min) [] @Desks' },
      { day: 'Wednesday',  period_number: 4, topic: 'Free play math',        objective: 'Explore math manipulatives freely',                 slide_number: '',   activities: '1. Free exploration (15min) [Math manipulatives] @Centers | 2. Clean-up and share (5min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 5, topic: 'Week reflection',       objective: 'Share one thing learned this week',                 slide_number: '',   activities: '1. Circle share (10min) [] @Carpet | 2. Draw and color (10min) [Crayons] @Desks' },
    ]
  },
  // Plan 2: Teacher Hodman — Foundation c Math
  {
    teacher_id: 'teacher-1774860362182-sy1bv0',
    class_name: 'Foundation c',
    title: 'Week 32 - Foundation c - Shapes and Colors',
    status: 'in_review',
    subject_id: 'subject-1774800978713-dmnf9s',
    periods: [
      { day: 'Saturday',   period_number: 1, topic: 'Basic shapes',         objective: 'Identify circle, square, triangle',          slide_number: '3',  activities: '1. Shape song (5min) [Audio] @Classroom | 2. Shape hunt (10min) [Clipboard] @Classroom | 3. Shape tracing (10min) [Tracing sheet] @Desks' },
      { day: 'Saturday',   period_number: 2, topic: 'Color recognition',    objective: 'Name red, blue, yellow, green',              slide_number: '4',  activities: '1. Color song (5min) [Audio] @Classroom | 2. Color sorting (10min) [Color items] @Carpet | 3. Color sheet (10min) [Crayons] @Desks' },
      { day: 'Saturday',   period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Saturday',   period_number: 4, topic: 'Sorting by shape',     objective: 'Sort objects by shape',                      slide_number: '5',  activities: '1. Shape sorting baskets (10min) [Baskets] @Carpet | 2. Cut and paste shapes (10min) [Scissors] @Desks' },
      { day: 'Saturday',   period_number: 5, topic: 'Shape walk',           objective: 'Find shapes in the environment',             slide_number: '6',  activities: '1. Walk around school (10min) [] @School grounds | 2. Draw what you saw (10min) [Crayons] @Desks' },
      { day: 'Sunday',     period_number: 1, topic: 'Rectangle and star',   objective: 'Identify rectangle and star shapes',         slide_number: '7',  activities: '1. Introduction (5min) [Flashcards] @Carpet | 2. Shape stamping (10min) [Stamps] @Art table | 3. Worksheet (10min) [Sheet] @Desks' },
      { day: 'Sunday',     period_number: 2, topic: 'Color mixing',         objective: 'Explore mixing primary colors',             slide_number: '8',  activities: '1. Demo with paint (10min) [Paint] @Art table | 2. Hands-on mixing (15min) [Paint cups] @Art table' },
      { day: 'Sunday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Sunday',     period_number: 4, topic: 'Shape patterns',       objective: 'Create AB patterns with shapes',            slide_number: '9',  activities: '1. Pattern demonstration (5min) [] @Carpet | 2. Build a pattern (10min) [Shape blocks] @Desks | 3. Extend the pattern (10min) [Worksheet] @Desks' },
      { day: 'Sunday',     period_number: 5, topic: 'Color by shape',       objective: 'Follow color key to color shapes',          slide_number: '10', activities: '1. Explain color key (5min) [] @Carpet | 2. Color by shape sheet (15min) [Crayons] @Desks' },
      { day: 'Monday',     period_number: 1, topic: 'Oval and diamond',     objective: 'Identify oval and diamond shapes',           slide_number: '11', activities: '1. New shapes intro (5min) [Cards] @Carpet | 2. Shape collage (15min) [Paper shapes] @Art table' },
      { day: 'Monday',     period_number: 2, topic: 'Color review',         objective: 'Review all colors learned',                 slide_number: '12', activities: '1. Color game (10min) [Ball] @Classroom | 2. Coloring page (10min) [Page] @Desks | 3. Color quiz (5min) [] @Carpet' },
      { day: 'Monday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Monday',     period_number: 4, topic: 'Shape sorting game',   objective: 'Sort shapes by attribute',                  slide_number: '13', activities: '1. Hoop sorting relay (10min) [Hoops] @Playground | 2. Table sorting (10min) [Shape tiles] @Tables' },
      { day: 'Monday',     period_number: 5, topic: 'Build with shapes',    objective: 'Create pictures using shapes',              slide_number: '14', activities: '1. Shape picture example (5min) [] @Carpet | 2. Build your own (15min) [Shape sets] @Desks | 3. Gallery walk (5min) [] @Classroom' },
      { day: 'Tuesday',    period_number: 1, topic: 'Shapes around us',     objective: 'Connect shapes to real-world objects',      slide_number: '15', activities: '1. I-spy shapes (10min) [] @Classroom | 2. Draw a shape house (10min) [Pencil] @Desks | 3. Share drawings (5min) [] @Carpet' },
      { day: 'Tuesday',    period_number: 2, topic: 'Color days',           objective: 'Associate colors with days of week',        slide_number: '16', activities: '1. Colorful calendar (10min) [Calendar] @Carpet | 2. Color day book (10min) [Booklet] @Desks' },
      { day: 'Tuesday',    period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Tuesday',    period_number: 4, topic: 'Shape art project',    objective: 'Create a shape collage',                    slide_number: '17', activities: '1. Plan collage (5min) [] @Carpet | 2. Create collage (15min) [Paper, glue] @Art table | 3. Clean up (5min) [] @Classroom' },
      { day: 'Tuesday',    period_number: 5, topic: 'Shape charades',       objective: 'Act out shapes for peers',                 slide_number: '',   activities: '1. Demonstrate charades (5min) [] @Carpet | 2. Play charades (10min) [] @Classroom | 3. Cool down (5min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 1, topic: 'Shape assessment',     objective: 'Assess shape and color knowledge',          slide_number: '18', activities: '1. One-on-one assessment (15min) [Flashcards] @Quiet corner | 2. Free drawing (10min) [Crayons] @Desks' },
      { day: 'Wednesday',  period_number: 2, topic: 'Color scavenger hunt', objective: 'Find items of specific colors',             slide_number: '19', activities: '1. Explain hunt (5min) [] @Carpet | 2. Scavenger hunt (10min) [] @Classroom | 3. Share findings (10min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Wednesday',  period_number: 4, topic: 'Shape review game',    objective: 'Review all shapes through play',            slide_number: '20', activities: '1. Bean bag toss on shapes (10min) [Bean bags] @Floor | 2. Bingo (10min) [Bingo cards] @Desks' },
      { day: 'Wednesday',  period_number: 5, topic: 'Week wrap-up',          objective: 'Reflect on the week learning',             slide_number: '',   activities: '1. What I learned (5min) [] @Carpet | 2. Star sticker chart (5min) [Stickers] @Desks | 3. Goodbye song (5min) [] @Carpet' },
    ]
  },
  // Plan 3: Teacher Sihaam — KG-C Arabic
  {
    teacher_id: 'teacher-1774860362182-nd4gsa',
    class_name: 'KG-C',
    title: 'Week 32 - KG-C - Arabic Letters Alif to Raa',
    status: 'in_review',
    subject_id: '2312',
    periods: [
      { day: 'Saturday',   period_number: 1, topic: 'Letter Alif',          objective: 'Recognize and pronounce Alif',              slide_number: '2',  activities: '1. Letter song (5min) [Audio] @Classroom | 2. Alif tracing (10min) [Workbook] @Desks | 3. Alif hunt (10min) [] @Classroom' },
      { day: 'Saturday',   period_number: 2, topic: 'Letter Baa',           objective: 'Recognize and pronounce Baa',               slide_number: '3',  activities: '1. Baa story (5min) [Storybook] @Carpet | 2. Baa tracing (10min) [Sheet] @Desks | 3. Baa coloring (10min) [Crayons] @Desks' },
      { day: 'Saturday',   period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Saturday',   period_number: 4, topic: 'Alif and Baa review',  objective: 'Differentiate Alif and Baa',               slide_number: '4',  activities: '1. Sorting game (10min) [Letter cards] @Carpet | 2. Memory match (10min) [Cards] @Tables' },
      { day: 'Saturday',   period_number: 5, topic: 'Letter Taa',           objective: 'Recognize and pronounce Taa',               slide_number: '5',  activities: '1. Taa chant (5min) [] @Carpet | 2. Tracing practice (10min) [Workbook] @Desks | 3. Find Taa (10min) [Magazine] @Desks' },
      { day: 'Sunday',     period_number: 1, topic: 'Letter Thaa',          objective: 'Recognize and pronounce Thaa',              slide_number: '6',  activities: '1. Thaa flash cards (5min) [Cards] @Carpet | 2. Thaa coloring (10min) [Page] @Desks | 3. Thaa playdough (10min) [Playdough] @Sensory' },
      { day: 'Sunday',     period_number: 2, topic: 'Letter Jeem',          objective: 'Recognize and pronounce Jeem',              slide_number: '7',  activities: '1. Jeem sound game (5min) [] @Carpet | 2. Jeem tracing (10min) [Sheet] @Desks | 3. Jeem craft (10min) [Craft supplies] @Art table' },
      { day: 'Sunday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Sunday',     period_number: 4, topic: 'Letters Taa-Thaa-Jeem', objective: 'Review Taa, Thaa, Jeem',                  slide_number: '8',  activities: '1. Letter relay (10min) [Letter cards] @Playground | 2. Matching worksheet (10min) [Worksheet] @Desks' },
      { day: 'Sunday',     period_number: 5, topic: 'Letter Haa',           objective: 'Recognize and pronounce Haa',               slide_number: '9',  activities: '1. Haa story (5min) [Book] @Carpet | 2. Haa tracing (10min) [Workbook] @Desks | 3. Haa dot-to-dot (10min) [Sheet] @Desks' },
      { day: 'Monday',     period_number: 1, topic: 'Letter Khaa',          objective: 'Recognize and pronounce Khaa',              slide_number: '10', activities: '1. Khaa sound intro (5min) [] @Carpet | 2. Khaa tracing (10min) [Sheet] @Desks | 3. Khaa collage (10min) [Tissue paper] @Art table' },
      { day: 'Monday',     period_number: 2, topic: 'Letter Daal',          objective: 'Recognize and pronounce Daal',              slide_number: '11', activities: '1. Daal song (5min) [Audio] @Carpet | 2. Daal tracing (10min) [Workbook] @Desks | 3. Daal find (10min) [] @Classroom' },
      { day: 'Monday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Monday',     period_number: 4, topic: 'Review Haa-Khaa-Daal', objective: 'Review letters Haa through Daal',           slide_number: '12', activities: '1. Bingo game (10min) [Bingo cards] @Desks | 2. Letter pocket sort (10min) [Pocket chart] @Carpet' },
      { day: 'Monday',     period_number: 5, topic: 'Letter Dhaal',         objective: 'Recognize and pronounce Dhaal',             slide_number: '13', activities: '1. Dhaal flash (5min) [Cards] @Carpet | 2. Dhaal tracing (10min) [Sheet] @Desks | 3. Dhaal drawing (10min) [Whiteboards] @Desks' },
      { day: 'Tuesday',    period_number: 1, topic: 'Letter Raa',           objective: 'Recognize and pronounce Raa',               slide_number: '14', activities: '1. Raa song (5min) [Audio] @Carpet | 2. Raa tracing (10min) [Workbook] @Desks | 3. Raa race game (10min) [] @Playground' },
      { day: 'Tuesday',    period_number: 2, topic: 'Full review Alif-Raa', objective: 'Review all letters from Alif to Raa',       slide_number: '15', activities: '1. Letter parade (10min) [Letter signs] @Classroom | 2. Comprehensive sheet (10min) [Sheet] @Desks | 3. Letter song (5min) [] @Carpet' },
      { day: 'Tuesday',    period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Tuesday',    period_number: 4, topic: 'Letter assessment',    objective: 'Assess letter recognition',                 slide_number: '',   activities: '1. One-on-one check (15min) [Cards] @Quiet corner | 2. Free letter play (10min) [Magnetic letters] @Board' },
      { day: 'Tuesday',    period_number: 5, topic: 'Arabic vocabulary',    objective: 'Learn words starting with Alif',            slide_number: '16', activities: '1. Picture cards (10min) [Cards] @Carpet | 2. Draw and label (10min) [Crayons] @Desks' },
      { day: 'Wednesday',  period_number: 1, topic: 'Writing practice',     objective: 'Write Alif to Raa independently',           slide_number: '17', activities: '1. Guided writing (10min) [Board] @Carpet | 2. Independent writing (10min) [Workbook] @Desks | 3. Peer check (5min) [] @Desks' },
      { day: 'Wednesday',  period_number: 2, topic: 'Letter game day',      objective: 'Reinforce letters through games',           slide_number: '',   activities: '1. Hop the letters (10min) [Tape letters] @Floor | 2. Letter fishing (10min) [Magnetic fish] @Sensory | 3. Puzzle match (5min) [Puzzles] @Tables' },
      { day: 'Wednesday',  period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Wednesday',  period_number: 4, topic: 'Arabic story time',    objective: 'Listen to Arabic story with known letters',  slide_number: '18', activities: '1. Read aloud (10min) [Arabic book] @Carpet | 2. Discuss story (5min) [] @Carpet | 3. Draw favorite part (10min) [Crayons] @Desks' },
      { day: 'Wednesday',  period_number: 5, topic: 'Week reflection',      objective: 'Share favorite letter learned',             slide_number: '',   activities: '1. Circle sharing (10min) [] @Carpet | 2. Sticker chart (5min) [Stickers] @Desks | 3. Goodbye song (5min) [] @Carpet' },
    ]
  },
  // Plan 4: Teacher Hooda Axmed — Foundation D English
  {
    teacher_id: 'teacher-1774860362182-4evun7',
    class_name: 'Foundation D',
    title: 'Week 32 - Foundation D - Phonics and Letter Sounds',
    status: 'in_review',
    subject_id: 'subject-1774800997392-o7km8l',
    periods: [
      { day: 'Saturday',   period_number: 1, topic: 'Letter A sound',       objective: 'Identify and pronounce short A sound',       slide_number: '4',  activities: '1. A song (5min) [Audio] @Carpet | 2. A picture sort (10min) [Picture cards] @Carpet | 3. A tracing (10min) [Workbook] @Desks' },
      { day: 'Saturday',   period_number: 2, topic: 'Letter B sound',       objective: 'Identify and pronounce B sound',             slide_number: '5',  activities: '1. B story (5min) [Book] @Carpet | 2. B beginning sounds (10min) [Cards] @Tables | 3. B craft (10min) [Supplies] @Art' },
      { day: 'Saturday',   period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Saturday',   period_number: 4, topic: 'A and B review',       objective: 'Differentiate A and B sounds',               slide_number: '6',  activities: '1. Sound sorting game (10min) [Baskets] @Carpet | 2. Color by letter (10min) [Sheet] @Desks' },
      { day: 'Saturday',   period_number: 5, topic: 'Letter C sound',       objective: 'Identify and pronounce C sound',             slide_number: '7',  activities: '1. C chant (5min) [] @Carpet | 2. C beginning sounds (10min) [Cards] @Tables | 3. C tracing (10min) [Workbook] @Desks' },
      { day: 'Sunday',     period_number: 1, topic: 'Letter D sound',       objective: 'Identify and pronounce D sound',             slide_number: '8',  activities: '1. D song (5min) [Audio] @Carpet | 2. D picture match (10min) [Puzzle] @Tables | 3. D writing (10min) [Sheet] @Desks' },
      { day: 'Sunday',     period_number: 2, topic: 'Letter E sound',       objective: 'Identify short E sound',                     slide_number: '9',  activities: '1. E story (5min) [Book] @Carpet | 2. E word building (10min) [Letters] @Carpet | 3. E coloring (10min) [Crayons] @Desks' },
      { day: 'Sunday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Sunday',     period_number: 4, topic: 'C-D-E review',         objective: 'Review letters C, D, E sounds',              slide_number: '10', activities: '1. Letter Bingo (10min) [Cards] @Desks | 2. Sound hopscotch (10min) [Tape] @Floor' },
      { day: 'Sunday',     period_number: 5, topic: 'Letter F sound',       objective: 'Identify and pronounce F sound',             slide_number: '11', activities: '1. F flash cards (5min) [Cards] @Carpet | 2. F beginning sounds (10min) [Worksheet] @Desks | 3. F craft fish (10min) [Paper plates] @Art' },
      { day: 'Monday',     period_number: 1, topic: 'Letter G sound',       objective: 'Identify and pronounce G sound',             slide_number: '12', activities: '1. G game (5min) [] @Carpet | 2. G sorting (10min) [Objects] @Sensory | 3. G tracing (10min) [Workbook] @Desks' },
      { day: 'Monday',     period_number: 2, topic: 'Letter H sound',       objective: 'Identify and pronounce H sound',             slide_number: '13', activities: '1. H song (5min) [Audio] @Carpet | 2. H hunt (10min) [] @Classroom | 3. H writing (10min) [Sheet] @Desks' },
      { day: 'Monday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Monday',     period_number: 4, topic: 'F-G-H review',         objective: 'Review F, G, H sounds',                      slide_number: '14', activities: '1. Sound sort relay (10min) [Cards] @Playground | 2. Letter match sheet (10min) [Sheet] @Desks' },
      { day: 'Monday',     period_number: 5, topic: 'Letter I sound',       objective: 'Identify short I sound',                     slide_number: '15', activities: '1. I story (5min) [Book] @Carpet | 2. I word building (10min) [Magnetic letters] @Board | 3. I coloring page (10min) [Crayons] @Desks' },
      { day: 'Tuesday',    period_number: 1, topic: 'Letter J sound',       objective: 'Identify and pronounce J sound',             slide_number: '16', activities: '1. J song and dance (5min) [Audio] @Carpet | 2. J beginning sounds (10min) [Cards] @Tables | 3. J tracing (10min) [Workbook] @Desks' },
      { day: 'Tuesday',    period_number: 2, topic: 'Letter K sound',       objective: 'Identify and pronounce K sound',             slide_number: '17', activities: '1. K kite craft (15min) [Supplies] @Art | 2. K sheet (10min) [Worksheet] @Desks' },
      { day: 'Tuesday',    period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Tuesday',    period_number: 4, topic: 'I-J-K review',         objective: 'Review I, J, K sounds',                      slide_number: '18', activities: '1. I-Spy sounds (10min) [] @Classroom | 2. Cut and paste sort (10min) [Scissors] @Desks' },
      { day: 'Tuesday',    period_number: 5, topic: 'Beginning sounds game',objective: 'Identify beginning sounds of words',          slide_number: '19', activities: '1. Mystery bag (10min) [Bag of objects] @Carpet | 2. Beginning sound sheet (10min) [Sheet] @Desks' },
      { day: 'Wednesday',  period_number: 1, topic: 'CVC words -at',        objective: 'Blend CVC words with -at family',            slide_number: '20', activities: '1. Word family song (5min) [Audio] @Carpet | 2. Build -at words (10min) [Letter tiles] @Tables | 3. Read -at words (10min) [Booklet] @Desks' },
      { day: 'Wednesday',  period_number: 2, topic: 'CVC words -an',        objective: 'Blend CVC words with -an family',            slide_number: '21', activities: '1. Word family intro (5min) [Chart] @Carpet | 2. -an word puzzles (10min) [Puzzles] @Tables | 3. Write -an words (10min) [Whiteboards] @Desks' },
      { day: 'Wednesday',  period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Wednesday',  period_number: 4, topic: 'Phonics assessment',   objective: 'Assess letter sound knowledge',              slide_number: '',   activities: '1. Quick sound check (15min) [Cards] @Quiet corner | 2. Free reading (10min) [Books] @Reading corner' },
      { day: 'Wednesday',  period_number: 5, topic: 'Week celebration',     objective: 'Celebrate phonics progress',                 slide_number: '',   activities: '1. Phonics dance party (10min) [Music] @Classroom | 2. Sticker reward (5min) [Stickers] @Desks | 3. Goodbye (5min) [] @Carpet' },
    ]
  },
  // Plan 5: hamda yonis tukale — KG-B Math
  {
    teacher_id: 'teacher-1774860751200-n7750m',
    class_name: 'KG-B',
    title: 'Week 33 - KG-B - Addition Within 5',
    status: 'in_review',
    subject_id: 'subject-1774800978713-dmnf9s',
    periods: [
      { day: 'Saturday',   period_number: 1, topic: 'Counting review 1-10', objective: 'Review counting objects 1-10',              slide_number: '2',  activities: '1. Counting song (5min) [Audio] @Carpet | 2. Count around room (10min) [] @Classroom | 3. Counting sheet (10min) [Worksheet] @Desks' },
      { day: 'Saturday',   period_number: 2, topic: 'Zero concept',         objective: 'Understand the concept of zero',             slide_number: '3',  activities: '1. Zero story (5min) [Book] @Carpet | 2. Zero jar activity (10min) [Jars] @Science | 3. Zero coloring (10min) [Page] @Desks' },
      { day: 'Saturday',   period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Saturday',   period_number: 4, topic: 'More than/less than',  objective: 'Compare quantities using more/less',         slide_number: '4',  activities: '1. More/less with blocks (10min) [Blocks] @Carpet | 2. More/less sheet (10min) [Sheet] @Desks | 3. Quick check (5min) [] @Desks' },
      { day: 'Saturday',   period_number: 5, topic: 'Joining groups',       objective: 'Combine two groups and count total',         slide_number: '5',  activities: '1. Bear counters joining (10min) [Bear counters] @Carpet | 2. Draw joining (10min) [Crayons] @Desks' },
      { day: 'Sunday',     period_number: 1, topic: 'Addition symbol +',    objective: 'Introduce the plus sign',                    slide_number: '6',  activities: '1. Plus sign story (5min) [] @Carpet | 2. Plus sign craft (10min) [Pipe cleaners] @Art | 3. Write + (10min) [Whiteboards] @Desks' },
      { day: 'Sunday',     period_number: 2, topic: 'Addition 1+1 to 1+3',  objective: 'Solve simple addition problems 1+1 to 1+3',  slide_number: '7',  activities: '1. Finger counting (5min) [] @Carpet | 2. Cube addition (10min) [Cubes] @Desks | 3. Match the sum (10min) [Cards] @Tables' },
      { day: 'Sunday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Sunday',     period_number: 4, topic: 'Addition 2+1 to 2+3',  objective: 'Solve 2+1, 2+2, 2+3',                        slide_number: '8',  activities: '1. Using number line (10min) [Number line] @Floor | 2. Domino addition (10min) [Dominoes] @Tables' },
      { day: 'Sunday',     period_number: 5, topic: 'Addition 3+1 to 3+2',  objective: 'Solve 3+1 and 3+2',                          slide_number: '9',  activities: '1. Toy addition (10min) [Small toys] @Carpet | 2. Addition sheet (10min) [Sheet] @Desks | 3. Partner check (5min) [] @Desks' },
      { day: 'Monday',     period_number: 1, topic: 'Addition up to 5',     objective: 'Solve all addition facts up to 5',            slide_number: '10', activities: '1. Finger flash (5min) [] @Carpet | 2. Addition matching game (10min) [Cards] @Tables | 3. Write problems (10min) [Whiteboards] @Desks' },
      { day: 'Monday',     period_number: 2, topic: 'Number bonds to 5',    objective: 'Understand number bonds for 5',               slide_number: '11', activities: '1. Five frame (10min) [Five frames] @Carpet | 2. Number bond song (5min) [Audio] @Carpet | 3. Number bond sheet (10min) [Sheet] @Desks' },
      { day: 'Monday',     period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Monday',     period_number: 4, topic: 'Addition word problems',objective: 'Solve simple word problems within 5',         slide_number: '12', activities: '1. Story problem demo (5min) [Puppet] @Carpet | 2. Act it out (10min) [] @Classroom | 3. Draw the problem (10min) [Crayons] @Desks' },
      { day: 'Monday',     period_number: 5, topic: 'Free addition play',   objective: 'Explore addition with manipulatives',         slide_number: '',   activities: '1. Center exploration (15min) [Math centers] @Centers | 2. Share discoveries (5min) [] @Carpet' },
      { day: 'Tuesday',    period_number: 1, topic: 'Addition review',      objective: 'Review all addition facts to 5',              slide_number: '13', activities: '1. Quick quiz (5min) [Quiz cards] @Carpet | 2. Addition bingo (10min) [Bingo cards] @Desks | 3. Partner practice (10min) [Flashcards] @Desks' },
      { day: 'Tuesday',    period_number: 2, topic: 'Addition game day',    objective: 'Reinforce addition through games',            slide_number: '',   activities: '1. Bean bag toss add (10min) [Bean bags] @Floor | 2. Addition board game (10min) [Game boards] @Tables' },
      { day: 'Tuesday',    period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Tuesday',    period_number: 4, topic: 'Addition assessment',  objective: 'Assess addition within 5',                    slide_number: '14', activities: '1. One-on-one assessment (15min) [Counters] @Quiet corner | 2. Self-check sheet (10min) [Sheet] @Desks' },
      { day: 'Tuesday',    period_number: 5, topic: 'Make 5 game',          objective: 'Practice making 5 in different ways',         slide_number: '',   activities: '1. Shake and spill (10min) [Counters] @Desks | 2. Make 5 book (10min) [Booklet] @Desks | 3. Share (5min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 1, topic: 'Adding with pictures', objective: 'Use pictures to solve addition problems',     slide_number: '15', activities: '1. Picture problem demo (5min) [Chart] @Carpet | 2. Picture addition sheet (10min) [Sheet] @Desks | 3. Draw your own (10min) [Crayons] @Desks' },
      { day: 'Wednesday',  period_number: 2, topic: 'Addition in real life',objective: 'Connect addition to everyday situations',      slide_number: '16', activities: '1. Snack time addition (10min) [Snacks] @Desks | 2. Role play store (10min) [Play items] @Dramatic play' },
      { day: 'Wednesday',  period_number: 3, topic: 'Free Period',          is_free: true },
      { day: 'Wednesday',  period_number: 4, topic: 'Unit review',          objective: 'Review all week addition concepts',           slide_number: '17', activities: '1. Carousel review stations (15min) [Activities] @Centers | 2. Wrap-up discussion (5min) [] @Carpet' },
      { day: 'Wednesday',  period_number: 5, topic: 'Addition celebration', objective: 'Celebrate learning addition',                 slide_number: '',   activities: '1. Addition certificate (10min) [Certificates] @Desks | 2. Fun addition video (10min) [Video] @Classroom | 3. Goodbye (5min) [] @Carpet' },
    ]
  },
];

// AI review template with varied scores
function generateReview(planTitle, seed) {
  const scores = [
    { lo: 4, ls: 5, se: 3, ts: 4, di: 3, am: 3, ca: 5, cm: 4, rm: 4, oq: 4, pct: 78, lvl: 'Good', sum: 'Well-structured plan with clear objectives and good resource use. Limited differentiation and assessment variety.' },
    { lo: 5, ls: 5, se: 4, ts: 4, di: 3, am: 4, ca: 5, cm: 4, rm: 5, oq: 4, pct: 86, lvl: 'Very Good', sum: 'Excellent curriculum alignment and learning objectives. Strong resource variety. Some room for differentiation strategies.' },
    { lo: 3, ls: 4, se: 4, ts: 3, di: 2, am: 3, ca: 4, cm: 3, rm: 4, oq: 3, pct: 66, lvl: 'Needs Improvement', sum: 'Adequate structure with engaging activities. Would benefit from clearer differentiation plans and varied assessments.' },
    { lo: 4, ls: 4, se: 5, ts: 4, di: 4, am: 3, ca: 4, cm: 4, rm: 4, oq: 4, pct: 80, lvl: 'Very Good', sum: 'Highly engaging activities with strong student interaction. Good structure. Assessment variety could be expanded.' },
    { lo: 5, ls: 5, se: 4, ts: 5, di: 4, am: 4, ca: 5, cm: 5, rm: 5, oq: 5, pct: 92, lvl: 'Excellent', sum: 'Exceptional plan with comprehensive objectives, varied teaching strategies, and strong differentiation. Excellent resource use.' },
  ][seed % 5];

  const total = scores.lo + scores.ls + scores.se + scores.ts + scores.di + scores.am + scores.ca + scores.cm + scores.rm + scores.oq;

  const improvements = [
    {
      area: 'Differentiation',
      why: 'Activities appear uniform without clear adjustments for varying student abilities.',
      recommendation: 'Include extension activities for advanced learners and scaffolding for students needing support.'
    },
    {
      area: 'Assessment Methods',
      why: 'Few formal assessment checkpoints throughout the week.',
      recommendation: 'Add quick formative assessments like exit tickets or thumbs up/down checks.'
    },
    {
      area: 'Student Engagement',
      why: 'Some periods rely heavily on worksheets which may reduce engagement.',
      recommendation: 'Incorporate more hands-on and movement-based activities.'
    },
  ];

  const strengths = [
    'Clear weekly structure with consistent routines',
    'Good variety of resources and materials',
    'Age-appropriate activities aligned with curriculum goals',
    'Strong integration of songs and movement for young learners',
  ];

  return {
    scores: {
      learning_objectives:     { score: scores.lo, explanation: 'Objectives are clear and measurable.' },
      lesson_structure:        { score: scores.ls, explanation: 'Lessons are logically sequenced.' },
      student_engagement:      { score: scores.se, explanation: 'Activities aim to engage students.' },
      teaching_strategies:     { score: scores.ts, explanation: 'Multiple strategies are employed.' },
      differentiation:         { score: scores.di, explanation: 'Some differentiation, but could be stronger.' },
      assessment_methods:      { score: scores.am, explanation: 'Basic assessment approaches used.' },
      curriculum_alignment:    { score: scores.ca, explanation: 'Well aligned with curriculum standards.' },
      classroom_management:    { score: scores.cm, explanation: 'Management strategies are appropriate.' },
      resources_materials:     { score: scores.rm, explanation: 'Resources are varied and accessible.' },
      overall_quality:         { score: scores.oq, explanation: 'Overall quality is solid.' },
    },
    executive_summary: scores.sum,
    total_score: total,
    percentage: scores.pct,
    performance_level: scores.lvl,
    strengths: strengths.slice(0, 2 + (seed % 3)),
    improvements: improvements.slice(0, 1 + (seed % 2)),
    ai_summary_notes: {
      status_recommendation: scores.pct >= 80 ? 'Approved' : scores.pct >= 70 ? 'Minor Revisions Recommended' : 'Significant Revisions Required',
      reasoning: `${planTitle}. ${scores.sum} Overall score of ${scores.pct}% indicates ${scores.lvl.toLowerCase()} performance.`
    },
  };
}

(async () => {
  let created = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const planId = newId('plan');
    console.log(`\n--- Creating plan ${i + 1}: ${p.title} ---`);

    const { error: planErr } = await supabase.from('lesson_plans').insert({
      id: planId,
      teacher_id: p.teacher_id,
      subject_id: p.subject_id,
      class_name: p.class_name,
      week_label: '2026-W33',
      title: p.title,
      status: p.status,
      period_count: 5,
    });
    if (planErr) { console.error('  Plan insert error:', planErr.message); continue; }
    console.log('  Plan created:', planId);

    // Insert periods
    const periodRows = p.periods.map((per, idx) => ({
      id: `period-${planId}-${per.day}-${per.period_number}`,
      plan_id: planId,
      day: per.day,
      period_number: per.period_number,
      topic: per.is_free ? 'Free Period' : per.topic,
      objective: per.is_free ? null : (per.objective || null),
      activities: per.is_free ? '' : (per.activities || ''),
      slide_number: per.is_free ? null : (per.slide_number || null),
      details: per.is_free ? [] : (per.activities ? per.activities.split('|').map(a => ({
        activity: a.trim(),
        time: '',
        resource: '',
        place: '',
      })) : []),
      class_name: p.class_name,
      subject: p.subject_id,
      is_free: per.is_free || false,
      sort_order: idx,
    }));

    const { error: periodErr } = await supabase.from('lesson_plan_periods').insert(periodRows);
    if (periodErr) { console.error('  Periods insert error:', periodErr.message); continue; }
    console.log(`  ${periodRows.length} periods inserted`);

    // Insert AI review
    const review = generateReview(p.title, i);
    const reviewId = `review-${planId}-${Date.now()}`;
    const { error: revErr } = await supabase.from('ai_reviews').insert({
      id: reviewId,
      plan_id: planId,
      scores: review.scores,
      executive_summary: review.executive_summary,
      total_score: review.total_score,
      percentage: review.percentage,
      performance_level: review.performance_level,
      strengths: review.strengths,
      improvements: review.improvements,
      ai_summary_notes: review.ai_summary_notes,
      additional_data: { latency_ms: 1200 + i * 300, model_used: 'google/gemma-4-31b-it', input_tokens: 1800, output_tokens: 600 },
      status: 'pending',
    });
    if (revErr) { console.error('  Review insert error:', revErr.message); continue; }
    console.log(`  AI Review created: ${review.percentage}% (${review.performance_level})`);

    created++;
  }
  console.log(`\n✅ Done! ${created}/${plans.length} lesson plans created with AI reviews.`);
  console.log('Log in as a supervisor to review them!');
})();
