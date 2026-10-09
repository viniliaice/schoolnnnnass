-- 20261009_authoritative_parent_phone_registry.sql
--
-- THE PROBLEM THIS SOLVES. Policy v3 correctly refuses to merge a pair whose two
-- records carry two DIFFERENT parent phone numbers: nothing in the database says
-- which one is right, so guessing would write a wrong phone onto a surviving
-- student record. 158 of the 254 production "Excluded" pairs are blocked for
-- exactly this reason, and no amount of cleverness inside the database can fix
-- that — it is missing information, not missing logic.
--
-- This migration supplies the missing information. The school provided a list of
-- 620 authoritative parent phone numbers. When a conflicting pair has EXACTLY
-- ONE of its two numbers on that list, the conflict is answered: that number is
-- the correct one and it wins.
--
-- WHAT THIS DELIBERATELY DOES *NOT* DO
--   * It never makes a pair a duplicate candidate. Strong duplicate identity
--     (normalized name + class, exactly one parent-assigned keeper, no history
--     conflict) is still required first. The registry only resolves a phone
--     conflict on a pair that is already a genuine duplicate.
--   * It never speaks for transport, family ID or Gov ID. Those rules are
--     untouched, so a pair with a phone conflict AND a family ID conflict stays
--     BLOCKED.
--   * It never resolves a conflict it cannot speak to. Both numbers on the list
--     -> parent_phone_registry_ambiguous (BLOCKED). Neither -> the existing
--     parent_phone_conflict (BLOCKED).
--   * It never overrides the third-party family check. If the endorsed number
--     already belongs to a DIFFERENT parent's family, copying it would fuse two
--     families, so the pair stays BLOCKED as parent_phone_belongs_to_other_family.
--   * An empty registry is a no-op: with no rows, v_auth_k and v_auth_r are both
--     false and behaviour is byte-identical to policy v3.
--
-- Every resolved pair records the authority and both raw numbers in
-- student_merge_audits.field_states, and any moved number lands in
-- transferred_fields, so a registry-driven change is never an invisible edit.

-- ─── 1. The registry ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.authoritative_parent_phones (
  phone     TEXT PRIMARY KEY,
  raw_phone TEXT NOT NULL,
  note      TEXT,
  source    TEXT NOT NULL DEFAULT 'admin_supplied',
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by  UUID REFERENCES auth.users (id),
  CONSTRAINT authoritative_parent_phones_normalized
    CHECK (phone = public.normalize_phone(phone) AND phone <> '')
);

COMMENT ON TABLE  public.authoritative_parent_phones IS
  'Parent phone numbers the school has confirmed as correct. Used ONLY to settle a parent_phone_conflict in the safe duplicate batch; never a basis for a merge.';
COMMENT ON COLUMN public.authoritative_parent_phones.phone IS
  'normalize_phone() of raw_phone. Lookups compare normalize_phone(student."parentPhone") against this.';

-- Seeded idempotently so re-running the migration cannot duplicate or reorder it.
INSERT INTO public.authoritative_parent_phones (phone, raw_phone, source)
VALUES
  ('633002604','633002604','admin_supplied'),
  ('633019044','633019044','admin_supplied'),
  ('633021568','633021568','admin_supplied'),
  ('633075339','633075339','admin_supplied'),
  ('633098469','633098469','admin_supplied'),
  ('633130823','633130823','admin_supplied'),
  ('633131413','633131413','admin_supplied'),
  ('633172764','633172764','admin_supplied'),
  ('633191742','633191742','admin_supplied'),
  ('633192212','633192212','admin_supplied'),
  ('633192707','633192707','admin_supplied'),
  ('633253200','633253200','admin_supplied'),
  ('633258550','633258550','admin_supplied'),
  ('633258697','633258697','admin_supplied'),
  ('633270156','633270156','admin_supplied'),
  ('633270538','633270538','admin_supplied'),
  ('633309217','633309217','admin_supplied'),
  ('633320917','633320917','admin_supplied'),
  ('633338880','633338880','admin_supplied'),
  ('633396094','633396094','admin_supplied'),
  ('633410723','633410723','admin_supplied'),
  ('633412392','633412392','admin_supplied'),
  ('633441802','633441802','admin_supplied'),
  ('633442111','633442111','admin_supplied'),
  ('633442375','633442375','admin_supplied'),
  ('633484102','633484102','admin_supplied'),
  ('633490908','633490908','admin_supplied'),
  ('633491451','633491451','admin_supplied'),
  ('633547543','633547543','admin_supplied'),
  ('633551782','633551782','admin_supplied'),
  ('633556900','633556900','admin_supplied'),
  ('633579552','633579552','admin_supplied'),
  ('633580432','633580432','admin_supplied'),
  ('633648733','633648733','admin_supplied'),
  ('633694137','633694137','admin_supplied'),
  ('633695744','633695744','admin_supplied'),
  ('633695827','633695827','admin_supplied'),
  ('633759588','633759588','admin_supplied'),
  ('633759647','633759647','admin_supplied'),
  ('633765223','633765223','admin_supplied'),
  ('633766260','633766260','admin_supplied'),
  ('633782941','633782941','admin_supplied'),
  ('633785230','633785230','admin_supplied'),
  ('633839492','633839492','admin_supplied'),
  ('633840867','633840867','admin_supplied'),
  ('633855383','633855383','admin_supplied'),
  ('633856355','633856355','admin_supplied'),
  ('633856684','633856684','admin_supplied'),
  ('633897710','633897710','admin_supplied'),
  ('633912440','633912440','admin_supplied'),
  ('633925454','633925454','admin_supplied'),
  ('633951636','633951636','admin_supplied'),
  ('633960846','633960846','admin_supplied'),
  ('633999309','633999309','admin_supplied'),
  ('634010949','634010949','admin_supplied'),
  ('634014378','634014378','admin_supplied'),
  ('634027662','634027662','admin_supplied'),
  ('634031490','634031490','admin_supplied'),
  ('634040085','634040085','admin_supplied'),
  ('634050228','634050228','admin_supplied'),
  ('634052806','634052806','admin_supplied'),
  ('634069700','634069700','admin_supplied'),
  ('634078520','634078520','admin_supplied'),
  ('634078722','634078722','admin_supplied'),
  ('634080514','634080514','admin_supplied'),
  ('634080814','634080814','admin_supplied'),
  ('634083388','634083388','admin_supplied'),
  ('634083956','634083956','admin_supplied'),
  ('634085459','634085459','admin_supplied'),
  ('634085744','634085744','admin_supplied'),
  ('634094353','634094353','admin_supplied'),
  ('634099675','634099675','admin_supplied'),
  ('634100199','634100199','admin_supplied'),
  ('634105831','634105831','admin_supplied'),
  ('634106439','634106439','admin_supplied'),
  ('634107375','634107375','admin_supplied'),
  ('634110808','634110808','admin_supplied'),
  ('634132227','634132227','admin_supplied'),
  ('634137552','634137552','admin_supplied'),
  ('634138773','634138773','admin_supplied'),
  ('634142619','634142619','admin_supplied'),
  ('634145714','634145714','admin_supplied'),
  ('634146800','634146800','admin_supplied'),
  ('634151205','634151205','admin_supplied'),
  ('634158190','634158190','admin_supplied'),
  ('634166007','634166007','admin_supplied'),
  ('634170873','634170873','admin_supplied'),
  ('634178207','634178207','admin_supplied'),
  ('634178388','634178388','admin_supplied'),
  ('634186626','634186626','admin_supplied'),
  ('634191171','634191171','admin_supplied'),
  ('634198145','634198145','admin_supplied'),
  ('634218915','634218915','admin_supplied'),
  ('634229626','634229626','admin_supplied'),
  ('634234330','634234330','admin_supplied'),
  ('634249334','634249334','admin_supplied'),
  ('634261502','634261502','admin_supplied'),
  ('634268149','634268149','admin_supplied'),
  ('634280834','634280834','admin_supplied'),
  ('634284033','634284033','admin_supplied'),
  ('634284762','634284762','admin_supplied'),
  ('634284801','634284801','admin_supplied'),
  ('634284919','634284919','admin_supplied'),
  ('634290650','634290650','admin_supplied'),
  ('634293366','634293366','admin_supplied'),
  ('634297085','634297085','admin_supplied'),
  ('634298719','634298719','admin_supplied'),
  ('634311699','634311699','admin_supplied'),
  ('634323372','634323372','admin_supplied'),
  ('634324297','634324297','admin_supplied'),
  ('634344833','634344833','admin_supplied'),
  ('634394180','634394180','admin_supplied'),
  ('634403176','634403176','admin_supplied'),
  ('634403786','634403786','admin_supplied'),
  ('634407569','634407569','admin_supplied'),
  ('634410949','634410949','admin_supplied'),
  ('634413431','634413431','admin_supplied'),
  ('634417655','634417655','admin_supplied'),
  ('634421742','634421742','admin_supplied'),
  ('634421895','634421895','admin_supplied'),
  ('634422065','634422065','admin_supplied'),
  ('634422727','634422727','admin_supplied'),
  ('634422911','634422911','admin_supplied'),
  ('634425871','634425871','admin_supplied'),
  ('634428590','634428590','admin_supplied'),
  ('634432955','634432955','admin_supplied'),
  ('634434807','634434807','admin_supplied'),
  ('634444127','634444127','admin_supplied'),
  ('634450007','634450007','admin_supplied'),
  ('634450035','634450035','admin_supplied'),
  ('634450110','634450110','admin_supplied'),
  ('634450127','634450127','admin_supplied'),
  ('634450130','634450130','admin_supplied'),
  ('634450135','634450135','admin_supplied'),
  ('634450217','634450217','admin_supplied'),
  ('634450274','634450274','admin_supplied'),
  ('634450691','634450691','admin_supplied'),
  ('634450700','634450700','admin_supplied'),
  ('634450829','634450829','admin_supplied'),
  ('634450868','634450868','admin_supplied'),
  ('634450902','634450902','admin_supplied'),
  ('634451005','634451005','admin_supplied'),
  ('634451072','634451072','admin_supplied'),
  ('634451207','634451207','admin_supplied'),
  ('634451415','634451415','admin_supplied'),
  ('634451489','634451489','admin_supplied'),
  ('634451642','634451642','admin_supplied'),
  ('634451665','634451665','admin_supplied'),
  ('634451723','634451723','admin_supplied'),
  ('634451804','634451804','admin_supplied'),
  ('634451859','634451859','admin_supplied'),
  ('634452054','634452054','admin_supplied'),
  ('634452088','634452088','admin_supplied'),
  ('634452112','634452112','admin_supplied'),
  ('634452114','634452114','admin_supplied'),
  ('634452118','634452118','admin_supplied'),
  ('634452325','634452325','admin_supplied'),
  ('634452391','634452391','admin_supplied'),
  ('634453420','634453420','admin_supplied'),
  ('634453468','634453468','admin_supplied'),
  ('634453489','634453489','admin_supplied'),
  ('634453599','634453599','admin_supplied'),
  ('634453657','634453657','admin_supplied'),
  ('634453713','634453713','admin_supplied'),
  ('634453722','634453722','admin_supplied'),
  ('634453815','634453815','admin_supplied'),
  ('634453923','634453923','admin_supplied'),
  ('634454007','634454007','admin_supplied'),
  ('634454025','634454025','admin_supplied'),
  ('634454271','634454271','admin_supplied'),
  ('634454327','634454327','admin_supplied'),
  ('634454334','634454334','admin_supplied'),
  ('634454343','634454343','admin_supplied'),
  ('634454434','634454434','admin_supplied'),
  ('634454616','634454616','admin_supplied'),
  ('634454626','634454626','admin_supplied'),
  ('634454727','634454727','admin_supplied'),
  ('634454807','634454807','admin_supplied'),
  ('634455029','634455029','admin_supplied'),
  ('634455051','634455051','admin_supplied'),
  ('634455080','634455080','admin_supplied'),
  ('634455146','634455146','admin_supplied'),
  ('634455225','634455225','admin_supplied'),
  ('634455292','634455292','admin_supplied'),
  ('634455409','634455409','admin_supplied'),
  ('634455439','634455439','admin_supplied'),
  ('634455470','634455470','admin_supplied'),
  ('634455570','634455570','admin_supplied'),
  ('634455581','634455581','admin_supplied'),
  ('634455598','634455598','admin_supplied'),
  ('634455609','634455609','admin_supplied'),
  ('634455631','634455631','admin_supplied'),
  ('634455637','634455637','admin_supplied'),
  ('634455852','634455852','admin_supplied'),
  ('634455880','634455880','admin_supplied'),
  ('634456010','634456010','admin_supplied'),
  ('634456038','634456038','admin_supplied'),
  ('634456079','634456079','admin_supplied'),
  ('634456221','634456221','admin_supplied'),
  ('634456235','634456235','admin_supplied'),
  ('634456404','634456404','admin_supplied'),
  ('634456413','634456413','admin_supplied'),
  ('634456663','634456663','admin_supplied'),
  ('634456726','634456726','admin_supplied'),
  ('634456764','634456764','admin_supplied'),
  ('634456779','634456779','admin_supplied'),
  ('634456823','634456823','admin_supplied'),
  ('634456847','634456847','admin_supplied'),
  ('634456914','634456914','admin_supplied'),
  ('634456923','634456923','admin_supplied'),
  ('634456925','634456925','admin_supplied'),
  ('634456930','634456930','admin_supplied'),
  ('634456949','634456949','admin_supplied'),
  ('634457364','634457364','admin_supplied'),
  ('634457478','634457478','admin_supplied'),
  ('634457521','634457521','admin_supplied'),
  ('634457528','634457528','admin_supplied'),
  ('634457755','634457755','admin_supplied'),
  ('634458068','634458068','admin_supplied'),
  ('634458209','634458209','admin_supplied'),
  ('634458303','634458303','admin_supplied'),
  ('634458323','634458323','admin_supplied'),
  ('634458383','634458383','admin_supplied'),
  ('634458626','634458626','admin_supplied'),
  ('634458675','634458675','admin_supplied'),
  ('634458975','634458975','admin_supplied'),
  ('634459188','634459188','admin_supplied'),
  ('634459189','634459189','admin_supplied'),
  ('634459374','634459374','admin_supplied'),
  ('634459686','634459686','admin_supplied'),
  ('634459688','634459688','admin_supplied'),
  ('634459825','634459825','admin_supplied'),
  ('634459884','634459884','admin_supplied'),
  ('634462270','634462270','admin_supplied'),
  ('634463984','634463984','admin_supplied'),
  ('634463991','634463991','admin_supplied'),
  ('634464714','634464714','admin_supplied'),
  ('634464883','634464883','admin_supplied'),
  ('634465810','634465810','admin_supplied'),
  ('634468215','634468215','admin_supplied'),
  ('634471778','634471778','admin_supplied'),
  ('634476203','634476203','admin_supplied'),
  ('634478883','634478883','admin_supplied'),
  ('634481025','634481025','admin_supplied'),
  ('634488719','634488719','admin_supplied'),
  ('634500091','634500091','admin_supplied'),
  ('634500229','634500229','admin_supplied'),
  ('634500363','634500363','admin_supplied'),
  ('634500497','634500497','admin_supplied'),
  ('634500946','634500946','admin_supplied'),
  ('634501263','634501263','admin_supplied'),
  ('634501521','634501521','admin_supplied'),
  ('634501809','634501809','admin_supplied'),
  ('634502039','634502039','admin_supplied'),
  ('634502455','634502455','admin_supplied'),
  ('634502617','634502617','admin_supplied'),
  ('634503527','634503527','admin_supplied'),
  ('634503548','634503548','admin_supplied'),
  ('634503595','634503595','admin_supplied'),
  ('634504400','634504400','admin_supplied'),
  ('634504887','634504887','admin_supplied'),
  ('634504924','634504924','admin_supplied'),
  ('634505145','634505145','admin_supplied'),
  ('634505514','634505514','admin_supplied'),
  ('634505552','634505552','admin_supplied'),
  ('634505631','634505631','admin_supplied'),
  ('634505656','634505656','admin_supplied'),
  ('634505748','634505748','admin_supplied'),
  ('634505808','634505808','admin_supplied'),
  ('634505961','634505961','admin_supplied'),
  ('634506036','634506036','admin_supplied'),
  ('634506449','634506449','admin_supplied'),
  ('634506524','634506524','admin_supplied'),
  ('634506719','634506719','admin_supplied'),
  ('634506741','634506741','admin_supplied'),
  ('634506785','634506785','admin_supplied'),
  ('634507314','634507314','admin_supplied'),
  ('634507731','634507731','admin_supplied'),
  ('634507855','634507855','admin_supplied'),
  ('634508069','634508069','admin_supplied'),
  ('634508090','634508090','admin_supplied'),
  ('634508172','634508172','admin_supplied'),
  ('634508347','634508347','admin_supplied'),
  ('634508893','634508893','admin_supplied'),
  ('634509544','634509544','admin_supplied'),
  ('634510000','634510000','admin_supplied'),
  ('634510020','634510020','admin_supplied'),
  ('634510162','634510162','admin_supplied'),
  ('634510283','634510283','admin_supplied'),
  ('634510490','634510490','admin_supplied'),
  ('634510583','634510583','admin_supplied'),
  ('634510850','634510850','admin_supplied'),
  ('634511387','634511387','admin_supplied'),
  ('634511399','634511399','admin_supplied'),
  ('634511556','634511556','admin_supplied'),
  ('634511816','634511816','admin_supplied'),
  ('634511988','634511988','admin_supplied'),
  ('634512318','634512318','admin_supplied'),
  ('634512329','634512329','admin_supplied'),
  ('634513080','634513080','admin_supplied'),
  ('634513108','634513108','admin_supplied'),
  ('634513125','634513125','admin_supplied'),
  ('634513355','634513355','admin_supplied'),
  ('634513385','634513385','admin_supplied'),
  ('634513626','634513626','admin_supplied'),
  ('634514557','634514557','admin_supplied'),
  ('634515339','634515339','admin_supplied'),
  ('634516273','634516273','admin_supplied'),
  ('634516618','634516618','admin_supplied'),
  ('634516667','634516667','admin_supplied'),
  ('634517824','634517824','admin_supplied'),
  ('634518033','634518033','admin_supplied'),
  ('634518135','634518135','admin_supplied'),
  ('634519800','634519800','admin_supplied'),
  ('634519872','634519872','admin_supplied'),
  ('634520050','634520050','admin_supplied'),
  ('634520131','634520131','admin_supplied'),
  ('634520171','634520171','admin_supplied'),
  ('634520223','634520223','admin_supplied'),
  ('634520862','634520862','admin_supplied'),
  ('634521358','634521358','admin_supplied'),
  ('634522355','634522355','admin_supplied'),
  ('634522530','634522530','admin_supplied'),
  ('634522703','634522703','admin_supplied'),
  ('634522741','634522741','admin_supplied'),
  ('634522861','634522861','admin_supplied'),
  ('634523822','634523822','admin_supplied'),
  ('634524461','634524461','admin_supplied'),
  ('634525708','634525708','admin_supplied'),
  ('634526249','634526249','admin_supplied'),
  ('634527274','634527274','admin_supplied'),
  ('634528666','634528666','admin_supplied'),
  ('634530237','634530237','admin_supplied'),
  ('634530319','634530319','admin_supplied'),
  ('634531111','634531111','admin_supplied'),
  ('634531744','634531744','admin_supplied'),
  ('634532266','634532266','admin_supplied'),
  ('634532553','634532553','admin_supplied'),
  ('634533909','634533909','admin_supplied'),
  ('634533917','634533917','admin_supplied'),
  ('634533923','634533923','admin_supplied'),
  ('634533995','634533995','admin_supplied'),
  ('634534403','634534403','admin_supplied'),
  ('634536820','634536820','admin_supplied'),
  ('634536976','634536976','admin_supplied'),
  ('634537150','634537150','admin_supplied'),
  ('634537250','634537250','admin_supplied'),
  ('634538006','634538006','admin_supplied'),
  ('634538014','634538014','admin_supplied'),
  ('634538081','634538081','admin_supplied'),
  ('634538824','634538824','admin_supplied'),
  ('634538925','634538925','admin_supplied'),
  ('634539457','634539457','admin_supplied'),
  ('634540304','634540304','admin_supplied'),
  ('634540323','634540323','admin_supplied'),
  ('634542005','634542005','admin_supplied'),
  ('634542031','634542031','admin_supplied'),
  ('634542520','634542520','admin_supplied'),
  ('634544209','634544209','admin_supplied'),
  ('634544288','634544288','admin_supplied'),
  ('634545147','634545147','admin_supplied'),
  ('634546622','634546622','admin_supplied'),
  ('634547226','634547226','admin_supplied'),
  ('634547398','634547398','admin_supplied'),
  ('634548413','634548413','admin_supplied'),
  ('634548847','634548847','admin_supplied'),
  ('634550464','634550464','admin_supplied'),
  ('634550542','634550542','admin_supplied'),
  ('634550552','634550552','admin_supplied'),
  ('634551584','634551584','admin_supplied'),
  ('634552188','634552188','admin_supplied'),
  ('634552422','634552422','admin_supplied'),
  ('634552629','634552629','admin_supplied'),
  ('634552656','634552656','admin_supplied'),
  ('634552869','634552869','admin_supplied'),
  ('634552924','634552924','admin_supplied'),
  ('634553252','634553252','admin_supplied'),
  ('634553633','634553633','admin_supplied'),
  ('634553913','634553913','admin_supplied'),
  ('634554722','634554722','admin_supplied'),
  ('634555034','634555034','admin_supplied'),
  ('634555502','634555502','admin_supplied'),
  ('634555580','634555580','admin_supplied'),
  ('634555726','634555726','admin_supplied'),
  ('634555943','634555943','admin_supplied'),
  ('634556144','634556144','admin_supplied'),
  ('634557611','634557611','admin_supplied'),
  ('634557678','634557678','admin_supplied'),
  ('634557685','634557685','admin_supplied'),
  ('634557819','634557819','admin_supplied'),
  ('634557955','634557955','admin_supplied'),
  ('634559033','634559033','admin_supplied'),
  ('634559736','634559736','admin_supplied'),
  ('634560496','634560496','admin_supplied'),
  ('634560720','634560720','admin_supplied'),
  ('634560779','634560779','admin_supplied'),
  ('634561060','634561060','admin_supplied'),
  ('634561329','634561329','admin_supplied'),
  ('634561854','634561854','admin_supplied'),
  ('634563113','634563113','admin_supplied'),
  ('634564354','634564354','admin_supplied'),
  ('634564841','634564841','admin_supplied'),
  ('634565117','634565117','admin_supplied'),
  ('634565551','634565551','admin_supplied'),
  ('634565980','634565980','admin_supplied'),
  ('634566141','634566141','admin_supplied'),
  ('634566804','634566804','admin_supplied'),
  ('634567045','634567045','admin_supplied'),
  ('634567267','634567267','admin_supplied'),
  ('634567390','634567390','admin_supplied'),
  ('634567407','634567407','admin_supplied'),
  ('634567878','634567878','admin_supplied'),
  ('634568807','634568807','admin_supplied'),
  ('634568987','634568987','admin_supplied'),
  ('634569431','634569431','admin_supplied'),
  ('634569434','634569434','admin_supplied'),
  ('634569728','634569728','admin_supplied'),
  ('634572563','634572563','admin_supplied'),
  ('634572596','634572596','admin_supplied'),
  ('634572723','634572723','admin_supplied'),
  ('634574555','634574555','admin_supplied'),
  ('634574745','634574745','admin_supplied'),
  ('634575162','634575162','admin_supplied'),
  ('634576143','634576143','admin_supplied'),
  ('634577072','634577072','admin_supplied'),
  ('634579390','634579390','admin_supplied'),
  ('634579844','634579844','admin_supplied'),
  ('634580612','634580612','admin_supplied'),
  ('634581177','634581177','admin_supplied'),
  ('634581555','634581555','admin_supplied'),
  ('634582085','634582085','admin_supplied'),
  ('634584565','634584565','admin_supplied'),
  ('634589959','634589959','admin_supplied'),
  ('634590107','634590107','admin_supplied'),
  ('634593670','634593670','admin_supplied'),
  ('634595639','634595639','admin_supplied'),
  ('634596291','634596291','admin_supplied'),
  ('634598274','634598274','admin_supplied'),
  ('634601035','634601035','admin_supplied'),
  ('634601717','634601717','admin_supplied'),
  ('634604111','634604111','admin_supplied'),
  ('634606307','634606307','admin_supplied'),
  ('634606466','634606466','admin_supplied'),
  ('634606775','634606775','admin_supplied'),
  ('634607667','634607667','admin_supplied'),
  ('634610049','634610049','admin_supplied'),
  ('634610551','634610551','admin_supplied'),
  ('634614742','634614742','admin_supplied'),
  ('634616777','634616777','admin_supplied'),
  ('634619215','634619215','admin_supplied'),
  ('634628554','634628554','admin_supplied'),
  ('634631389','634631389','admin_supplied'),
  ('634634081','634634081','admin_supplied'),
  ('634636721','634636721','admin_supplied'),
  ('634648426','634648426','admin_supplied'),
  ('634651797','634651797','admin_supplied'),
  ('634659505','634659505','admin_supplied'),
  ('634666891','634666891','admin_supplied'),
  ('634680084','634680084','admin_supplied'),
  ('634683069','634683069','admin_supplied'),
  ('634696899','634696899','admin_supplied'),
  ('634699636','634699636','admin_supplied'),
  ('634717080','634717080','admin_supplied'),
  ('634724496','634724496','admin_supplied'),
  ('634750102','634750102','admin_supplied'),
  ('634752264','634752264','admin_supplied'),
  ('634789732','634789732','admin_supplied'),
  ('634794446','634794446','admin_supplied'),
  ('634807386','634807386','admin_supplied'),
  ('634810876','634810876','admin_supplied'),
  ('634873707','634873707','admin_supplied'),
  ('634880404','634880404','admin_supplied'),
  ('634884505','634884505','admin_supplied'),
  ('634884689','634884689','admin_supplied'),
  ('634884805','634884805','admin_supplied'),
  ('634884967','634884967','admin_supplied'),
  ('634884968','634884968','admin_supplied'),
  ('634885079','634885079','admin_supplied'),
  ('634885190','634885190','admin_supplied'),
  ('634885281','634885281','admin_supplied'),
  ('634892848','634892848','admin_supplied'),
  ('634892930','634892930','admin_supplied'),
  ('634892967','634892967','admin_supplied'),
  ('634893489','634893489','admin_supplied'),
  ('634893584','634893584','admin_supplied'),
  ('634894740','634894740','admin_supplied'),
  ('634894968','634894968','admin_supplied'),
  ('634900485','634900485','admin_supplied'),
  ('636004216','636004216','admin_supplied'),
  ('636066903','636066903','admin_supplied'),
  ('636069163','636069163','admin_supplied'),
  ('636095657','636095657','admin_supplied'),
  ('636119547','636119547','admin_supplied'),
  ('636169078','636169078','admin_supplied'),
  ('636200407','636200407','admin_supplied'),
  ('636234551','636234551','admin_supplied'),
  ('636275204','636275204','admin_supplied'),
  ('636279282','636279282','admin_supplied'),
  ('636322309','636322309','admin_supplied'),
  ('636372024','636372024','admin_supplied'),
  ('636372980','636372980','admin_supplied'),
  ('636381697','636381697','admin_supplied'),
  ('636397902','636397902','admin_supplied'),
  ('636406476','636406476','admin_supplied'),
  ('636493793','636493793','admin_supplied'),
  ('636537702','636537702','admin_supplied'),
  ('636547547','636547547','admin_supplied'),
  ('636558209','636558209','admin_supplied'),
  ('636558988','636558988','admin_supplied'),
  ('636625879','636625879','admin_supplied'),
  ('636631887','636631887','admin_supplied'),
  ('636689174','636689174','admin_supplied'),
  ('636735744','636735744','admin_supplied'),
  ('636776017','636776017','admin_supplied'),
  ('636814280','636814280','admin_supplied'),
  ('636814382','636814382','admin_supplied'),
  ('636821909','636821909','admin_supplied'),
  ('636871184','636871184','admin_supplied'),
  ('636892801','636892801','admin_supplied'),
  ('636907902','636907902','admin_supplied'),
  ('636928054','636928054','admin_supplied'),
  ('636981724','636981724','admin_supplied'),
  ('637080052','637080052','admin_supplied'),
  ('637080214','637080214','admin_supplied'),
  ('637090032','637090032','admin_supplied'),
  ('637090731','637090731','admin_supplied'),
  ('637091735','637091735','admin_supplied'),
  ('637161228','637161228','admin_supplied'),
  ('637162492','637162492','admin_supplied'),
  ('637187777','637187777','admin_supplied'),
  ('637188875','637188875','admin_supplied'),
  ('637216397','637216397','admin_supplied'),
  ('637217131','637217131','admin_supplied'),
  ('637290176','637290176','admin_supplied'),
  ('637292420','637292420','admin_supplied'),
  ('637305997','637305997','admin_supplied'),
  ('637329394','637329394','admin_supplied'),
  ('637329951','637329951','admin_supplied'),
  ('637343608','637343608','admin_supplied'),
  ('637377397','637377397','admin_supplied'),
  ('637432134','637432134','admin_supplied'),
  ('637433079','637433079','admin_supplied'),
  ('637499349','637499349','admin_supplied'),
  ('637521504','637521504','admin_supplied'),
  ('637583907','637583907','admin_supplied'),
  ('637584785','637584785','admin_supplied'),
  ('637612831','637612831','admin_supplied'),
  ('637638344','637638344','admin_supplied'),
  ('637661209','637661209','admin_supplied'),
  ('637687012','637687012','admin_supplied'),
  ('637702226','637702226','admin_supplied'),
  ('637703025','637703025','admin_supplied'),
  ('637724646','637724646','admin_supplied'),
  ('637725155','637725155','admin_supplied'),
  ('637745831','637745831','admin_supplied'),
  ('637745933','637745933','admin_supplied'),
  ('637746995','637746995','admin_supplied'),
  ('637747340','637747340','admin_supplied'),
  ('637779615','637779615','admin_supplied'),
  ('637797300','637797300','admin_supplied'),
  ('637803569','637803569','admin_supplied'),
  ('637803854','637803854','admin_supplied'),
  ('637816117','637816117','admin_supplied'),
  ('637816881','637816881','admin_supplied'),
  ('637817546','637817546','admin_supplied'),
  ('637871267','637871267','admin_supplied'),
  ('637921070','637921070','admin_supplied'),
  ('637921079','637921079','admin_supplied'),
  ('637940786','637940786','admin_supplied'),
  ('637998977','637998977','admin_supplied'),
  ('638003971','638003971','admin_supplied'),
  ('638008131','638008131','admin_supplied'),
  ('638075557','638075557','admin_supplied'),
  ('638082391','638082391','admin_supplied'),
  ('638126624','638126624','admin_supplied'),
  ('638149646','638149646','admin_supplied'),
  ('638183093','638183093','admin_supplied'),
  ('638183117','638183117','admin_supplied'),
  ('638226588','638226588','admin_supplied'),
  ('638253995','638253995','admin_supplied'),
  ('638261750','638261750','admin_supplied'),
  ('638299294','638299294','admin_supplied'),
  ('638319719','638319719','admin_supplied'),
  ('638339978','638339978','admin_supplied'),
  ('638418633','638418633','admin_supplied'),
  ('638418692','638418692','admin_supplied'),
  ('638497948','638497948','admin_supplied'),
  ('638522198','638522198','admin_supplied'),
  ('638537403','638537403','admin_supplied'),
  ('638549485','638549485','admin_supplied'),
  ('638551171','638551171','admin_supplied'),
  ('638556149','638556149','admin_supplied'),
  ('638583802','638583802','admin_supplied'),
  ('638628642','638628642','admin_supplied'),
  ('638648607','638648607','admin_supplied'),
  ('638674967','638674967','admin_supplied'),
  ('638675966','638675966','admin_supplied'),
  ('638733165','638733165','admin_supplied'),
  ('638796656','638796656','admin_supplied'),
  ('638803575','638803575','admin_supplied'),
  ('638804833','638804833','admin_supplied'),
  ('638931411','638931411','admin_supplied'),
  ('638959987','638959987','admin_supplied'),
  ('638960204','638960204','admin_supplied'),
  ('638961596','638961596','admin_supplied'),
  ('639078186','639078186','admin_supplied'),
  ('639199782','639199782','admin_supplied'),
  ('639219271','639219271','admin_supplied'),
  ('639262861','639262861','admin_supplied'),
  ('639283973','639283973','admin_supplied'),
  ('639362490','639362490','admin_supplied'),
  ('639381810','639381810','admin_supplied'),
  ('639408500','639408500','admin_supplied'),
  ('639450992','639450992','admin_supplied'),
  ('654456190','654456190','admin_supplied'),
  ('659259307','659259307','admin_supplied'),
  ('906763973','906763973','admin_supplied'),
  ('907662360','907662360','admin_supplied'),
  ('907742030','907742030','admin_supplied'),
  ('907782302','907782302','admin_supplied')
ON CONFLICT (phone) DO NOTHING;

ALTER TABLE public.authoritative_parent_phones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can read the authoritative parent phone registry"
  ON public.authoritative_parent_phones;
CREATE POLICY "Staff can read the authoritative parent phone registry"
  ON public.authoritative_parent_phones FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','teacher'));

DROP POLICY IF EXISTS "Admins maintain the authoritative parent phone registry"
  ON public.authoritative_parent_phones;
CREATE POLICY "Admins maintain the authoritative parent phone registry"
  ON public.authoritative_parent_phones FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');

REVOKE ALL ON TABLE public.authoritative_parent_phones FROM PUBLIC;
GRANT SELECT ON TABLE public.authoritative_parent_phones TO authenticated;

-- ─── 2. The policy, now version 4 ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safe_duplicate_batch_policy()
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'policyId', 'safe_batch_parent_assigned_keeper',
    'version', 4,
    'nameEn', 'Merge All Safe Duplicates',
    'nameAr', 'دمج جميع سجلات الطلاب الآمنة المكررة',
    'keeperRuleEn', 'The parent-assigned record will be kept. The unassigned duplicate will be merged into it.',
    'keeperRuleAr', 'يُحتفظ بالسجل الذي لديه ولي أمر معيّن، ويُدمج فيه السجل المكرر غير المعیَّن.',
    'keeperRule', 'KEEP the parent-assigned record; MERGE the unassigned duplicate into it and remove it only after transactional verification. The keeper is never chosen by record order, age, or the caller''s "canonical" label.',
    'confirmPhrase', 'MERGE SAFE DUPLICATES',
    'chunkSize', jsonb_build_object('default', 25, 'min', 1, 'max', 50, 'atomicPerChunk', true),
    'requiredConditions', jsonb_build_array(
      'same_normalized_name',
      'same_current_class',
      'exactly_one_parent_assigned',
      'candidate_group_has_exactly_two_records',
      'no_conflicting_gov_id',
      'gov_id_not_owned_by_a_third_student',
      'no_conflicting_parent_phone',
      'no_conflicting_transport',
      'no_conflicting_family_id',
      'assigned_parent_profile_exists',
      'neither_record_marked_left',
      'safe_enrollment_state',
      'no_exam_conflict',
      'no_attendance_conflict',
      'no_quiz_conflict',
      'no_release_conflict',
      'no_report_comment_conflict',
      'no_unhandled_child_dependency'
    ),
    'fieldResolutions', jsonb_build_object(
      'name', 'keeper value (names are normalized-identical by contract)',
      'className', 'keeper value (identical by contract — the stable Student ID keeps its class)',
      'govId', 'keeper value; if the keeper is blank the removed record''s Gov ID is moved onto the keeper (never discarded), only when no third student owns it',
      'parentId', 'keeper value (the parent-assigned record is the keeper)',
      'parentPhone', 'safe union: keeper value wins; a phone only on the duplicate is transferred to the keeper when no other family uses it; two different non-empty phones BLOCK unless the authoritative parent-phone registry endorses exactly one of them — then that number wins and the change is recorded in the merge audit',
      'transport', 'safe union: keeper value wins; a transport only on the duplicate is transferred; two different non-empty transports BLOCK',
      'familyId', 'safe union, most conservative: same id keeps one; a family id only on the duplicate is transferred ONLY when the keeper''s parent provably already owns that id on a sibling; a different family id, or an unprovable one, BLOCKS or goes to review — never guessed',
      'history', 'transferred with the existing individual-merge logic; excluded when any conflict would require an administrator choice',
      'enrollment', 'consolidate (same class + same academic year) / transfer (only the duplicate has an open enrollment) / preserve_history (duplicate has no open enrollment)'
    ),
    'exclusionCodes', jsonb_build_object(
      'group_has_more_than_two_records', 'More than two records share this name and class — ambiguous, individual review',
      'student_missing', 'One of the two records no longer exists',
      'name_conflict', 'Normalized names differ',
      'name_blank', 'Name is blank',
      'class_conflict', 'Current class differs — class changes must preserve the stable Student ID',
      'class_blank', 'Class is blank',
      'both_parents_assigned', 'Parent conflict — both records have a parent assigned',
      'parent_conflict', 'Parent conflict — both records point at different parents',
      'both_parents_unassigned', 'Neither record has a parent assigned — no keeper under the batch rule',
      'parent_profile_missing', 'The assigned parent profile does not exist',
      'student_marked_left', 'One record is marked LEFT — ambiguous enrollment state',
      'gov_id_conflict', 'Gov ID conflict — two different Government IDs',
      'gov_id_belongs_to_third_student', 'Gov ID could belong to a third student',
      'parent_phone_conflict', 'Parent phone conflict — two different non-empty numbers and the authoritative registry endorses NEITHER; a human must choose',
      'parent_phone_registry_ambiguous', 'Parent phone conflict — the authoritative registry endorses BOTH numbers, so it cannot pick a winner; a human must choose',
      'parent_phone_belongs_to_other_family', 'The phone on the duplicate already belongs to a DIFFERENT parent''s family — copying it would fuse two families',
      'transport_conflict', 'Transport conflict — two different non-empty values; a human must choose',
      'family_id_conflict', 'Family ID conflict — the two records, or the keeper''s parent''s siblings, already carry a different family ID',
      'family_id_invalid_normalization', 'A raw Family ID is present but contains no digit, so normalize_family_id() erases it — the family relationship cannot be read, individual review',
      'family_id_transfer_unproven', 'Only the duplicate has a family ID and the database cannot prove the keeper belongs to that family — individual review, never guessed',
      'multiple_open_enrollments', 'Ambiguous enrollment state — more than one open enrollment',
      'no_open_enrollment', 'Ambiguous enrollment state — no open enrollment to keep',
      'enrollment_class_conflict', 'Enrollment class differs from the current class',
      'enrollment_year_conflict', 'Enrollment academic year differs',
      'exam_conflict', 'Exam identity conflict — an administrator must choose which result survives',
      'attendance_conflict', 'Attendance date conflict — an administrator must choose',
      'quiz_conflict', 'Quiz attempt conflict — an administrator must choose',
      'release_conflict', 'Release log conflict (same UTC day) — an administrator must choose',
      'report_comment_conflict', 'Report comment conflict (same term) — an administrator must choose',
      'unhandled_child_dependency', 'The duplicate has rows in a student relationship the merge logic does not move — refusing to delete them silently',
      'candidate_changed_since_preview', 'Candidate changed since preview',
      'candidate_changed_during_batch', 'Candidate changed while the batch was running',
      'already_resolved', 'Already resolved (another administrator merged it, or the record is gone)',
      'not_eligible_server_side', 'Not eligible on the server — a client list can never authorize a merge',
      'not_a_candidate', 'Not a duplicate candidate at all'
    ),
    'blockedCodes', jsonb_build_array(
      'gov_id_conflict','gov_id_belongs_to_third_student','both_parents_assigned','parent_conflict',
      'parent_phone_conflict','parent_phone_belongs_to_other_family','parent_phone_registry_ambiguous','transport_conflict',
      'family_id_conflict','student_missing',
      'parent_profile_missing','multiple_open_enrollments','enrollment_class_conflict',
      'enrollment_year_conflict','exam_conflict','attendance_conflict','quiz_conflict',
      'release_conflict','report_comment_conflict','unhandled_child_dependency','name_conflict',
      'class_conflict','not_eligible_server_side'
    ),
    'reuses', jsonb_build_array(
      'get_duplicate_candidates() grouping rule (normalized name + current class)',
      'merge_duplicate_students_resolved() — validation, resolution, audit, verification, delete',
      'student_merge_audits — one detailed audit row per merged student',
      'audit_logs — students.merge per merge, students.merge_batch per chunk'
    ),
    'fieldConsolidation', jsonb_build_object(
      'ruleEn', 'Safe union: keeper value → preserve; only keeper → preserve; only duplicate → transfer; identical → keep one; different → block. Missing data on one side is never treated as a conflict.',
      'ruleAr', 'الاتحاد الآمن: قيمة السجل المحتفظ به تُحفظ، والقيمة الموجودة في السجل المكرر فقط تُنقل، والمتطابقة يُحتفظ بواحدة، والمختلفة تُمنع. نقص البيانات في طرف واحد لا يُعتبر تعارضًا.',
      'precondition', 'Consolidation is NEVER the basis for a merge. Strong duplicate identity from the authoritative policy (normalized name + class, one parent-assigned keeper, no history conflict) is still required first.',
      'auditedBy', 'student_merge_audits.transferred_fields + .field_states + .removed_profile — every value copied off the removed record is recorded with its field name, and the removed record''s raw profile is retained',
      'normalizationGuard', 'A raw familyId that normalize_family_id() would erase (no digit at all) is never treated as blank: the pair goes to individual review rather than merging and deleting an unreadable value',
      'phoneRegistry', 'public.authoritative_parent_phones (20261009) is the school''s answer to "which of these two numbers is right". It only RESOLVES a conflict that already exists; it is never a basis for a merge, it never touches any other field, and when it endorses both sides or neither side the pair stays BLOCKED for a human'
    ),
    'invariants', jsonb_build_array(
      'keeper: exactly 1 open enrollment after the merge',
      'removed record: 0 open enrollments and 0 remaining rows before deletion',
      'removed record: deleted only after zero-dependency verification',
      'kept Student ID: unchanged and preserved'
    )
  );
$$;

-- ─── 3. Pair evaluation with the registry branch ────────────────────────────
CREATE OR REPLACE FUNCTION public._safe_batch_evaluate_pair(
  p_a_id TEXT,
  p_b_id TEXT,
  p_group_size INTEGER DEFAULT 2,
  p_deep BOOLEAN DEFAULT true
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_a RECORD; v_b RECORD;
  v_keeper RECORD; v_removed RECORD;
  v_keeper_id TEXT; v_removed_id TEXT;
  v_keeper_is_a BOOLEAN;
  v_codes TEXT[] := ARRAY[]::TEXT[];
  v_ok TEXT[] := ARRAY[]::TEXT[];
  v_blocked BOOLEAN := false;
  v_review BOOLEAN := false;
  v_gk_k TEXT; v_gk_r TEXT;
  v_ph_k TEXT; v_ph_r TEXT;
  -- Registry endorsement flags for the true-conflict case (20261009).
  v_auth_k BOOLEAN := false; v_auth_r BOOLEAN := false;
  v_tr_k TEXT; v_tr_r TEXT;
  v_fam_k TEXT; v_fam_r TEXT;
  -- The RAW stored values, kept separately because normalize_family_id() can
  -- erase them: a raw id with no digit at all normalizes to ''. Comparing only
  -- the normalized values would make a populated field look blank.
  v_fam_raw_k TEXT; v_fam_raw_r TEXT;
  v_gov_choice TEXT := 'canonical';
  v_phone_choice TEXT := 'canonical';
  v_transport_choice TEXT := 'canonical';
  v_enroll_action TEXT := NULL;
  v_enroll_keep TEXT := 'canonical';
  v_open_k INT := 0; v_open_r INT := 0; v_hist_k INT := 0; v_hist_r INT := 0;
  v_enr_k RECORD; v_enr_r RECORD;
  v_exams_k INT := 0; v_exams_r INT := 0; v_exam_conf INT := 0;
  v_att_k INT := 0; v_att_r INT := 0; v_att_conf INT := 0;
  v_hw_k INT := 0; v_hw_r INT := 0;
  v_prom_k INT := 0; v_prom_r INT := 0;
  v_quiz_k INT := 0; v_quiz_r INT := 0; v_quiz_conf INT := 0;
  v_pick_k INT := 0; v_pick_r INT := 0;
  v_rel_k INT := 0; v_rel_r INT := 0; v_rel_conf INT := 0;
  v_rep_k INT := 0; v_rep_r INT := 0; v_rep_conf INT := 0;
  v_child RECORD;
  v_child_tables TEXT[] := ARRAY[]::TEXT[];
  v_child_rows INT := 0;
  v_parent_exists INT := 0;
  v_third_gov INT := 0;
  v_phone_third INT := 0;
  v_family_sibling INT := 0;
  v_family_other INT := 0;
  -- Safe-union bookkeeping. `transfers` records every value that will be COPIED
  -- from the removed record onto the keeper; `fieldStates` records how each
  -- nullable profile field was classified. Both land in the merge audit, so a
  -- transferred value is never an invisible side effect.
  v_transfer JSONB := '{}'::jsonb;
  v_field_states JSONB := '{}'::jsonb;
  v_group_size INT := COALESCE(p_group_size, 2);
  v_deep_eval BOOLEAN := COALESCE(p_deep, true);
  v_eligible BOOLEAN;
  v_fingerprint TEXT := NULL;
  v_class TEXT;
BEGIN
  -- 0. Authorization — the SAME guard the batch RPCs use (existing pattern).
  --    The evaluation JSONB carries Gov IDs, parent phones, family ids and both
  --    parent profiles for ANY two student ids, so it must never run for a
  --    non-admin caller. The SECURITY DEFINER batch RPCs (get / preview / merge)
  --    authorize the administrator first and then call this helper, so the
  --    shipped batch flow is unchanged.
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may evaluate safe batch duplicate pairs.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_a FROM public.students WHERE id = p_a_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'pairKey', COALESCE(p_a_id,'?') || '>' || COALESCE(p_b_id,'?'),
      'keeperId', p_a_id, 'removedId', p_b_id,
      'eligible', false, 'severity', 'blocked',
      'exclusionCodes', to_jsonb(ARRAY['student_missing']::TEXT[]),
      'eligibilityCodes', '[]'::jsonb);
  END IF;
  SELECT * INTO v_b FROM public.students WHERE id = p_b_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'pairKey', COALESCE(p_a_id,'?') || '>' || COALESCE(p_b_id,'?'),
      'keeperId', p_a_id, 'removedId', p_b_id,
      'eligible', false, 'severity', 'blocked',
      'exclusionCodes', to_jsonb(ARRAY['student_missing']::TEXT[]),
      'eligibilityCodes', '[]'::jsonb);
  END IF;

  -- ── Keeper selection: THE parent-assigned record (explicit batch policy) ──
  v_keeper_is_a := (v_a."parentId" IS NOT NULL AND v_b."parentId" IS NULL);
  IF v_keeper_is_a THEN
    v_keeper_id := p_a_id; v_removed_id := p_b_id;
  ELSIF (v_b."parentId" IS NOT NULL AND v_a."parentId" IS NULL) THEN
    v_keeper_id := p_b_id; v_removed_id := p_a_id;
  ELSE
    -- Both assigned or both unassigned: excluded. Order only affects reporting.
    IF v_a."createdAt" IS NOT DISTINCT FROM v_b."createdAt" THEN
      v_keeper_id := LEAST(p_a_id, p_b_id); v_removed_id := GREATEST(p_a_id, p_b_id);
    ELSIF v_a."createdAt" < v_b."createdAt" THEN
      v_keeper_id := p_a_id; v_removed_id := p_b_id;
    ELSE
      v_keeper_id := p_b_id; v_removed_id := p_a_id;
    END IF;
  END IF;

  SELECT * INTO v_keeper FROM public.students WHERE id = v_keeper_id;
  SELECT * INTO v_removed FROM public.students WHERE id = v_removed_id;
  v_class := v_keeper."className";

  -- ── Identity ────────────────────────────────────────────────────────────
  IF v_group_size > 2 THEN
    v_codes := array_append(v_codes, 'group_has_more_than_two_records'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'candidate_group_has_exactly_two_records');
  END IF;

  IF btrim(COALESCE(public.name_match_key(v_keeper.name), '')) = '' THEN
    v_codes := array_append(v_codes, 'name_blank'); v_blocked := true;
  ELSIF public.name_match_key(v_keeper.name) IS DISTINCT FROM public.name_match_key(v_removed.name) THEN
    v_codes := array_append(v_codes, 'name_conflict'); v_blocked := true;
  ELSE
    v_ok := array_append(v_ok, 'same_normalized_name');
  END IF;

  IF btrim(COALESCE(v_keeper."className", '')) = '' OR btrim(COALESCE(v_removed."className", '')) = '' THEN
    v_codes := array_append(v_codes, 'class_blank'); v_blocked := true;
  ELSIF v_keeper."className" IS DISTINCT FROM v_removed."className" THEN
    v_codes := array_append(v_codes, 'class_conflict'); v_blocked := true;
  ELSE
    v_ok := array_append(v_ok, 'same_current_class');
  END IF;

  -- ── Parent: exactly one assigned ────────────────────────────────────────
  IF v_keeper."parentId" IS NOT NULL AND v_removed."parentId" IS NOT NULL THEN
    v_codes := array_append(v_codes, 'both_parents_assigned'); v_blocked := true;
    IF v_keeper."parentId" IS DISTINCT FROM v_removed."parentId" THEN
      v_codes := array_append(v_codes, 'parent_conflict');
    END IF;
  ELSIF v_keeper."parentId" IS NULL AND v_removed."parentId" IS NULL THEN
    v_codes := array_append(v_codes, 'both_parents_unassigned'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'exactly_one_parent_assigned');
    v_ok := array_append(v_ok, 'keeper_is_parent_assigned');
  END IF;

  -- A LEFT student has no gate card / family grouping: ambiguous state.
  IF upper(btrim(COALESCE(v_keeper.transport, ''))) = 'LEFT'
     OR upper(btrim(COALESCE(v_removed.transport, ''))) = 'LEFT' THEN
    v_codes := array_append(v_codes, 'student_marked_left'); v_review := true;
  END IF;

  -- ── Gov ID ──────────────────────────────────────────────────────────────
  v_gk_k := COALESCE(public.gov_id_match_key(v_keeper."govId"), '');
  v_gk_r := COALESCE(public.gov_id_match_key(v_removed."govId"), '');
  IF v_gk_k <> '' AND v_gk_r <> '' AND v_gk_k = v_gk_r THEN
    v_ok := array_append(v_ok, 'same_gov_id');
    v_gov_choice := 'canonical';
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_gk_k <> '' AND v_gk_r <> '' THEN
    v_codes := array_append(v_codes, 'gov_id_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','conflict','action','block'));
  ELSIF v_gk_k <> '' THEN
    v_ok := array_append(v_ok, 'gov_id_keeper_only');
    v_gov_choice := 'canonical';
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_gk_r <> '' THEN
    -- Preserve the only recorded Gov ID by moving it onto the keeper through
    -- the existing validated resolution ('duplicate' choice) — never discard it.
    -- Safe because the third-student uniqueness check below still runs.
    v_ok := array_append(v_ok, 'gov_id_from_removed_preserved');
    v_gov_choice := 'duplicate';
    v_transfer := v_transfer || jsonb_build_object('govId', v_removed."govId");
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','duplicate_only','action','transfer',
                                  'value', v_removed."govId"));
  ELSE
    v_ok := array_append(v_ok, 'no_gov_id');
    v_gov_choice := 'canonical';
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  IF v_gk_k <> '' OR v_gk_r <> '' THEN
    SELECT count(*) INTO v_third_gov
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND public.gov_id_match_key(s."govId") <> ''
      AND public.gov_id_match_key(s."govId") = GREATEST(v_gk_k, v_gk_r);
    IF COALESCE(v_third_gov, 0) > 0 THEN
      v_codes := array_append(v_codes, 'gov_id_belongs_to_third_student'); v_blocked := true;
    END IF;
  END IF;

  -- ── Parent phone: true conflict vs one-sided missing data ────────────────
  -- A value present on only ONE record is NOT a conflict; two DIFFERENT
  -- non-empty values are. A one-sided phone is carried onto the keeper, but
  -- never blindly: the school's own family key (20260819) is the parent id and
  -- falls back to the normalized phone, so a phone already used by a DIFFERENT
  -- parent is a real collision — copying it would fuse two families. The same
  -- phone on a sibling of the same parent is corroboration, not a conflict.
  v_ph_k := COALESCE(public.normalize_phone(v_keeper."parentPhone"), '');
  v_ph_r := COALESCE(public.normalize_phone(v_removed."parentPhone"), '');
  IF v_ph_k <> '' AND v_ph_r <> '' AND v_ph_k = v_ph_r THEN
    v_ok := array_append(v_ok, 'same_parent_phone');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_ph_k <> '' AND v_ph_r <> '' THEN
    -- A TRUE conflict: two different non-empty numbers. The batch cannot choose
    -- between them on its own — but the school may already have settled which
    -- number is correct. public.authoritative_parent_phones is that answer.
    -- It is deliberately narrow: it only RESOLVES a conflict that already
    -- exists, it never makes a pair a duplicate candidate, and it never speaks
    -- for any other field.
    --   exactly one side endorsed -> that number wins, recorded in the audit
    --   both sides endorsed       -> registry is ambiguous, BLOCKED
    --   neither side endorsed     -> unchanged, BLOCKED for a human
    SELECT EXISTS (SELECT 1 FROM public.authoritative_parent_phones a WHERE a.phone = v_ph_k),
           EXISTS (SELECT 1 FROM public.authoritative_parent_phones a WHERE a.phone = v_ph_r)
      INTO v_auth_k, v_auth_r;

    IF v_auth_k AND NOT v_auth_r THEN
      -- The endorsed number is already the keeper's, so nothing moves.
      v_ok := array_append(v_ok, 'parent_phone_conflict_resolved_by_registry_keeper');
      v_phone_choice := 'canonical';
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict_resolved','action','keep',
                                          'authority','registry_keeper',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone",
                                          'value', v_keeper."parentPhone",
                                          'normalized', v_ph_k));
    ELSIF v_auth_r AND NOT v_auth_k THEN
      -- The endorsed number is on the duplicate, so it must MOVE onto the
      -- keeper. The third-party family check still applies: an authoritative
      -- number that already belongs to a DIFFERENT parent's family would still
      -- fuse two families, and the registry does not license that.
      SELECT count(*) INTO v_phone_third
      FROM public.students s
      WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
        AND public.normalize_phone(s."parentPhone") = v_ph_r
        AND s."parentId" IS NOT NULL
        AND s."parentId" IS DISTINCT FROM v_keeper."parentId";
      IF COALESCE(v_phone_third, 0) > 0 THEN
        v_codes := array_append(v_codes, 'parent_phone_belongs_to_other_family'); v_blocked := true;
        v_field_states := v_field_states || jsonb_build_object(
          'parentPhone', jsonb_build_object('state','conflict_resolved','action','block',
                                            'reason','parent_phone_belongs_to_other_family',
                                            'authority','registry_duplicate',
                                            'otherFamilyStudents', v_phone_third,
                                            'keeper', v_keeper."parentPhone",
                                            'removed', v_removed."parentPhone"));
      ELSE
        v_ok := array_append(v_ok, 'parent_phone_conflict_resolved_by_registry_duplicate');
        v_phone_choice := 'duplicate';
        v_transfer := v_transfer || jsonb_build_object('parentPhone', v_removed."parentPhone");
        v_field_states := v_field_states || jsonb_build_object(
          'parentPhone', jsonb_build_object('state','conflict_resolved','action','transfer',
                                            'authority','registry_duplicate',
                                            'keeper', v_keeper."parentPhone",
                                            'removed', v_removed."parentPhone",
                                            'value', v_removed."parentPhone",
                                            'normalized', v_ph_r));
      END IF;
    ELSIF v_auth_k AND v_auth_r THEN
      v_codes := array_append(v_codes, 'parent_phone_registry_ambiguous'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict','action','block',
                                          'reason','parent_phone_registry_ambiguous',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone"));
    ELSE
      v_codes := array_append(v_codes, 'parent_phone_conflict'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict','action','block',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone"));
    END IF;
  ELSIF v_ph_k <> '' THEN
    v_ok := array_append(v_ok, 'parent_phone_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_ph_r <> '' THEN
    SELECT count(*) INTO v_phone_third
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND public.normalize_phone(s."parentPhone") = v_ph_r
      AND s."parentId" IS NOT NULL
      AND s."parentId" IS DISTINCT FROM v_keeper."parentId";
    IF COALESCE(v_phone_third, 0) > 0 THEN
      -- This phone already belongs to another parent's family. Copying it onto
      -- the keeper would silently merge two distinct families.
      v_codes := array_append(v_codes, 'parent_phone_belongs_to_other_family'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','duplicate_only','action','block',
                                          'reason','parent_phone_belongs_to_other_family',
                                          'otherFamilyStudents', v_phone_third,
                                          'value', v_removed."parentPhone"));
    ELSE
      v_ok := array_append(v_ok, 'parent_phone_from_removed_preserved');
      v_phone_choice := 'duplicate';
      v_transfer := v_transfer || jsonb_build_object('parentPhone', v_removed."parentPhone");
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','duplicate_only','action','transfer',
                                          'value', v_removed."parentPhone",
                                          'normalized', v_ph_r));
    END IF;
  ELSE
    v_ok := array_append(v_ok, 'no_parent_phone');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  -- ── Transport ───────────────────────────────────────────────────────────
  -- students.transport is a SCALAR (students_transport_check: 'WALKER', 'CAR',
  -- 'LEFT' or a bus number) with no relational child rows — the real
  -- driver↔student relationship is authorized_pickup_students, which the shared
  -- merge RPC already moves with ON CONFLICT DO NOTHING. So copying the scalar
  -- is the complete preservation; nothing relational is left behind.
  -- 'LEFT' never reaches here: student_marked_left already excluded the pair.
  v_tr_k := btrim(COALESCE(v_keeper.transport, ''));
  v_tr_r := btrim(COALESCE(v_removed.transport, ''));
  IF v_tr_k <> '' AND v_tr_r <> '' AND upper(v_tr_k) = upper(v_tr_r) THEN
    v_ok := array_append(v_ok, 'same_transport');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_tr_k <> '' AND v_tr_r <> '' THEN
    -- e.g. WALKER vs bus 9 — an administrator must choose which is correct.
    v_codes := array_append(v_codes, 'transport_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','conflict','action','block',
                                      'keeper', v_keeper.transport,
                                      'removed', v_removed.transport));
  ELSIF v_tr_k <> '' THEN
    v_ok := array_append(v_ok, 'transport_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_tr_r <> '' THEN
    -- One-sided: carry it across. The value already satisfies
    -- students_transport_check because it is stored on a live row.
    v_ok := array_append(v_ok, 'transport_from_removed_preserved');
    v_transport_choice := 'duplicate';
    v_transfer := v_transfer || jsonb_build_object('transport', v_removed.transport);
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','duplicate_only','action','transfer',
                                      'value', v_removed.transport));
  ELSE
    v_ok := array_append(v_ok, 'no_transport');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  -- ── Family ID (deliberately the most conservative field) ─────────────────
  -- There is NO families table: familyId is a TEXT column on students
  -- (20260802_office_role.sql) and the authoritative grouping is the family key
  -- used by generate_family_ids() — 'p:'||parentId, else 't:'||phone — under the
  -- invariant "one family key → one family ID for the lifetime of the key"
  -- (20260819). So "the same family" is provable ONLY from sibling records that
  -- share the keeper's parent. Absence of evidence is not evidence: if the
  -- database cannot prove it, the pair goes to individual review rather than
  -- being merged on a guess. A family relationship is never replaced silently.
  v_fam_k := COALESCE(public.normalize_family_id(v_keeper."familyId"), '');
  v_fam_r := COALESCE(public.normalize_family_id(v_removed."familyId"), '');
  v_fam_raw_k := btrim(COALESCE(v_keeper."familyId", ''));
  v_fam_raw_r := btrim(COALESCE(v_removed."familyId", ''));

  -- ── GUARD: normalization must never silently erase a family ID ───────────
  -- normalize_family_id() is regexp_replace(raw, '\D', '', 'g') (20260802:55),
  -- so a raw family id containing no digit — 'HOUSE-RED', 'FAM-ABC' — normalizes
  -- to ''. Without this guard the chain below sees '' on that side, classifies
  -- the pair "both_blank", marks it SAFE, transfers nothing, and then the merge
  -- DELETES the duplicate: the value is destroyed and never appears in
  -- transferred_fields, so the usual "nothing was lost" check passes vacuously.
  --
  -- The policy cannot reason about a family relationship it cannot read, so the
  -- pair goes to INDIVIDUAL REVIEW. Not SAFE. Not blocked either — this is not a
  -- proven family conflict, the information is simply unreadable. Every existing
  -- family rule below (same → keep, proven → transfer, conflicting → blocked,
  -- unprovable → review) is unchanged and still runs for readable values.
  IF (v_fam_raw_k <> '' AND v_fam_k = '') OR (v_fam_raw_r <> '' AND v_fam_r = '') THEN
    IF v_fam_raw_k <> '' AND v_fam_raw_k = v_fam_raw_r THEN
      -- Both sides hold byte-identical raw values. The keeper survives holding
      -- them, so nothing can be lost and there is nothing to compare: this is
      -- the same-family case, reached by raw comparison instead of normalized.
      -- Without this, the individual-review workflow could never merge a pair it
      -- had just corrected by copying the value across.
      v_ok := array_append(v_ok, 'same_family_id');
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','identical','action','keep',
          'raw', v_fam_raw_k, 'comparedBy','raw'));
    ELSE
      v_codes := array_append(v_codes, 'family_id_invalid_normalization'); v_review := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object(
          'state','invalid_normalization','action','review',
          'reason','family_id_invalid_normalization',
          'keeperRaw', NULLIF(v_fam_raw_k, ''), 'removedRaw', NULLIF(v_fam_raw_r, ''),
          'keeperNormalized', NULLIF(v_fam_k, ''), 'removedNormalized', NULLIF(v_fam_r, '')));
    END IF;
  ELSIF v_fam_k <> '' AND v_fam_r <> '' AND v_fam_k = v_fam_r THEN
    v_ok := array_append(v_ok, 'same_family_id');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_fam_k <> '' AND v_fam_r <> '' THEN
    v_codes := array_append(v_codes, 'family_id_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','conflict','action','block',
                                     'keeper', v_keeper."familyId",
                                     'removed', v_removed."familyId"));
  ELSIF v_fam_k <> '' THEN
    v_ok := array_append(v_ok, 'family_id_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_fam_r <> '' THEN
    -- Does the keeper's own parent already belong to a DIFFERENT family?
    SELECT count(*) INTO v_family_other
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND v_keeper."parentId" IS NOT NULL
      AND s."parentId" = v_keeper."parentId"
      AND public.normalize_family_id(s."familyId") <> ''
      AND public.normalize_family_id(s."familyId") <> v_fam_r;
    -- Do siblings of the keeper's parent already hold exactly THIS family id?
    SELECT count(*) INTO v_family_sibling
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND v_keeper."parentId" IS NOT NULL
      AND s."parentId" = v_keeper."parentId"
      AND public.normalize_family_id(s."familyId") = v_fam_r;

    IF COALESCE(v_family_other, 0) > 0 THEN
      v_codes := array_append(v_codes, 'family_id_conflict'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','block',
                                       'reason','keeper_parent_already_in_other_family',
                                       'value', v_removed."familyId",
                                       'otherFamilyStudents', v_family_other));
    ELSIF COALESCE(v_family_sibling, 0) > 0 THEN
      -- PROVEN: the keeper's parent already owns this exact family id on a
      -- sibling, so the keeper joins a family it demonstrably belongs to.
      v_ok := array_append(v_ok, 'family_id_from_removed_preserved');
      v_transfer := v_transfer || jsonb_build_object('familyId', v_removed."familyId");
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','transfer',
                                       'value', v_removed."familyId",
                                       'proof', 'keeper_parent_sibling_holds_same_family_id',
                                       'siblingCount', v_family_sibling));
    ELSE
      -- Not provable either way. Never guess at a family relationship.
      v_codes := array_append(v_codes, 'family_id_transfer_unproven'); v_review := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','review',
                                       'reason','family_id_transfer_unproven',
                                       'value', v_removed."familyId"));
    END IF;
  ELSE
    v_ok := array_append(v_ok, 'no_family_id');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  -- ── Assigned parent must actually exist (the merge RPC validates it) ────
  IF v_keeper."parentId" IS NOT NULL THEN
    SELECT count(*) INTO v_parent_exists FROM public.profiles WHERE id = v_keeper."parentId";
    IF COALESCE(v_parent_exists, 0) = 0 THEN
      SELECT count(*) INTO v_parent_exists FROM public.users WHERE id = v_keeper."parentId";
    END IF;
    IF COALESCE(v_parent_exists, 0) = 0 THEN
      v_codes := array_append(v_codes, 'parent_profile_missing'); v_blocked := true;
    ELSE
      v_ok := array_append(v_ok, 'parent_profile_exists');
    END IF;
  END IF;

  -- ── Deep evaluation: enrollment + history (only when profile is clean) ──
  IF v_deep_eval AND array_length(v_codes, 1) IS NULL THEN
    SELECT count(*) INTO v_open_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NULL;
    SELECT count(*) INTO v_open_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NULL;
    SELECT count(*) INTO v_hist_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NOT NULL;
    SELECT count(*) INTO v_hist_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NOT NULL;
    SELECT * INTO v_enr_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NULL LIMIT 1;
    SELECT * INTO v_enr_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NULL LIMIT 1;

    IF v_open_k > 1 OR v_open_r > 1 THEN
      v_codes := array_append(v_codes, 'multiple_open_enrollments'); v_blocked := true;
    ELSIF v_open_k = 0 AND v_open_r = 0 THEN
      -- The final invariant needs exactly one open enrollment on the keeper.
      v_codes := array_append(v_codes, 'no_open_enrollment'); v_review := true;
    ELSIF v_open_k = 0 AND v_open_r = 1 THEN
      v_enroll_action := 'transfer';
      IF v_enr_r."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
        v_enroll_action := NULL;
      ELSE
        v_ok := array_append(v_ok, 'enrollment_transfer');
      END IF;
    ELSIF v_open_r = 0 THEN
      v_enroll_action := 'preserve_history';
      IF v_enr_k."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
        v_enroll_action := NULL;
      ELSE
        v_ok := array_append(v_ok, 'enrollment_preserve_history');
      END IF;
    ELSE
      -- exactly one open on each side
      IF v_enr_k."className" IS DISTINCT FROM v_enr_r."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
      ELSIF v_enr_k."academicYearId" IS DISTINCT FROM v_enr_r."academicYearId" THEN
        v_codes := array_append(v_codes, 'enrollment_year_conflict'); v_blocked := true;
      ELSIF v_enr_k."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
      ELSE
        v_enroll_action := 'consolidate';
        v_ok := array_append(v_ok, 'enrollment_consolidate');
      END IF;
    END IF;

    -- History counts (transferred with the existing individual-merge logic)
    SELECT count(*) INTO v_exams_k FROM public.exams WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_exams_r FROM public.exams WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_att_k FROM public.attendance WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_att_r FROM public.attendance WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_hw_k FROM public.homework WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_hw_r FROM public.homework WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_prom_k FROM public.student_promotions WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_prom_r FROM public.student_promotions WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_quiz_k FROM public.quiz_attempts WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_quiz_r FROM public.quiz_attempts WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_pick_k FROM public.authorized_pickup_students WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_pick_r FROM public.authorized_pickup_students WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_rel_k FROM public.release_log WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_rel_r FROM public.release_log WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_rep_k FROM public.report_comments WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_rep_r FROM public.report_comments WHERE "studentId" = v_removed_id;

    -- Conflicts: anything that would force an administrator to choose.
    SELECT count(*) INTO v_exam_conf
    FROM public.exams d
    JOIN public.exams c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id
      AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
      AND c."examType" = d."examType"
      AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
      AND c."termId" IS NOT DISTINCT FROM d."termId";
    IF COALESCE(v_exam_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'exam_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_att_conf
    FROM public.attendance d
    JOIN public.attendance c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c.date = d.date;
    IF COALESCE(v_att_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'attendance_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_quiz_conf
    FROM public.quiz_attempts d
    JOIN public.quiz_attempts c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c."quizId" = d."quizId";
    IF COALESCE(v_quiz_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'quiz_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_rel_conf
    FROM public.release_log d
    JOIN public.release_log c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id
      AND (d."createdAt" AT TIME ZONE 'UTC')::date = (c."createdAt" AT TIME ZONE 'UTC')::date;
    IF COALESCE(v_rel_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'release_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_rep_conf
    FROM public.report_comments d
    JOIN public.report_comments c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c."termId" = d."termId";
    IF COALESCE(v_rep_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'report_comment_conflict'); v_blocked := true;
    END IF;

    IF array_length(v_codes, 1) IS NULL THEN
      v_ok := array_append(v_ok, 'no_history_conflicts');
      v_ok := array_append(v_ok, 'history_transfer_safe');
    END IF;

    -- FK safety net: rows the merge logic does not move must never be deleted.
    FOR v_child IN SELECT * FROM public._safe_batch_unhandled_child_rows(v_removed_id) LOOP
      v_child_rows := v_child_rows + GREATEST(v_child.row_count, 0);
      v_child_tables := array_append(v_child_tables, v_child.table_name);
    END LOOP;
    IF v_child_rows > 0 OR array_length(v_child_tables, 1) > 0 THEN
      v_codes := array_append(v_codes, 'unhandled_child_dependency'); v_blocked := true;
    END IF;
  END IF;

  v_eligible := array_length(v_codes, 1) IS NULL AND v_deep_eval;

  -- Staleness fingerprint: every field the contract depends on. Compared again
  -- after row locks at execution time, so a changed candidate is never merged.
  IF v_deep_eval AND v_eligible THEN
    v_fingerprint := md5(concat_ws('|',
      v_keeper_id, v_removed_id,
      COALESCE(v_keeper.name,''), COALESCE(v_removed.name,''),
      COALESCE(v_keeper."className",''), COALESCE(v_removed."className",''),
      COALESCE(v_keeper."govId",''), COALESCE(v_removed."govId",''),
      COALESCE(v_keeper."parentId",''), COALESCE(v_removed."parentId",''),
      COALESCE(v_keeper."parentPhone",''), COALESCE(v_removed."parentPhone",''),
      COALESCE(v_keeper.transport,''), COALESCE(v_removed.transport,''),
      COALESCE(v_keeper."familyId",''), COALESCE(v_removed."familyId",''),
      v_group_size::TEXT,
      v_open_k::TEXT, v_open_r::TEXT, v_hist_k::TEXT, v_hist_r::TEXT,
      COALESCE(v_enr_k.id,''), COALESCE(v_enr_r.id,''),
      COALESCE(v_enr_k."className",''), COALESCE(v_enr_r."className",''),
      COALESCE(v_enr_k."academicYearId",''), COALESCE(v_enr_r."academicYearId",''),
      v_exams_k::TEXT, v_exams_r::TEXT, v_exam_conf::TEXT,
      v_att_k::TEXT, v_att_r::TEXT, v_att_conf::TEXT,
      v_hw_k::TEXT, v_hw_r::TEXT,
      v_prom_k::TEXT, v_prom_r::TEXT,
      v_quiz_k::TEXT, v_quiz_r::TEXT, v_quiz_conf::TEXT,
      v_pick_k::TEXT, v_pick_r::TEXT,
      v_rel_k::TEXT, v_rel_r::TEXT, v_rel_conf::TEXT,
      v_rep_k::TEXT, v_rep_r::TEXT, v_rep_conf::TEXT,
      v_enroll_action, v_gov_choice, v_phone_choice, v_transport_choice,
      v_transfer::TEXT, v_field_states::TEXT
    ));
  END IF;

  RETURN jsonb_build_object(
    'pairKey', v_keeper_id || '>' || v_removed_id,
    'groupKey', COALESCE(public.name_match_key(v_keeper.name),'') || '|' || COALESCE(v_class,''),
    'groupSize', v_group_size,
    'keeperId', v_keeper_id,
    'removedId', v_removed_id,
    'studentName', v_keeper.name,
    'className', v_class,
    'eligible', v_eligible,
    'severity', CASE WHEN v_eligible THEN NULL WHEN v_blocked THEN 'blocked' ELSE 'review' END,
    'exclusionCodes', to_jsonb(v_codes),
    'eligibilityCodes', to_jsonb(v_ok),
    'keeperIsParentAssigned', (v_keeper."parentId" IS NOT NULL),
    'keeper', jsonb_build_object(
      'id', v_keeper.id, 'name', v_keeper.name, 'className', v_keeper."className",
      'govId', v_keeper."govId", 'parentId', v_keeper."parentId",
      'parentName', (SELECT p.name FROM public.profiles p WHERE p.id = v_keeper."parentId" LIMIT 1),
      'parentPhone', v_keeper."parentPhone", 'transport', v_keeper.transport,
      'familyId', v_keeper."familyId", 'createdAt', v_keeper."createdAt"),
    'removed', jsonb_build_object(
      'id', v_removed.id, 'name', v_removed.name, 'className', v_removed."className",
      'govId', v_removed."govId", 'parentId', v_removed."parentId",
      'parentName', (SELECT p.name FROM public.profiles p WHERE p.id = v_removed."parentId" LIMIT 1),
      'parentPhone', v_removed."parentPhone", 'transport', v_removed.transport,
      'familyId', v_removed."familyId", 'createdAt', v_removed."createdAt"),
    'resolution', jsonb_build_object(
      'summary', jsonb_build_object(
        'govId', v_gov_choice, 'parentPhone', v_phone_choice,
        'transport', v_transport_choice, 'enrollment', COALESCE(v_enroll_action,'none')),
      -- Exactly the payload merge_duplicate_students_resolved() validates.
      'mergeResolution', jsonb_build_object(
        'profile_resolution', jsonb_build_object(
          'name', 'canonical',
          'class_name', 'canonical',
          'gov_id', v_gov_choice,
          'parent_id', 'canonical',
          'parent_phone', v_phone_choice,
          'transport', v_transport_choice),
        'exam_resolution', '[]'::jsonb,
        'attendance_resolution', '[]'::jsonb,
        'quiz_resolution', '[]'::jsonb,
        'release_resolution', '[]'::jsonb,
        'report_comment_resolution', '[]'::jsonb,
        'enrollment_resolution', CASE
          WHEN v_enroll_action IS NULL THEN NULL
          ELSE jsonb_build_object('action', v_enroll_action, 'keep', v_enroll_keep) END)
    ),
    'enrollmentAction', v_enroll_action,
    'history', jsonb_build_object(
      'exams', jsonb_build_object('keeper', v_exams_k, 'removed', v_exams_r, 'conflicts', v_exam_conf),
      'attendance', jsonb_build_object('keeper', v_att_k, 'removed', v_att_r, 'conflicts', v_att_conf),
      'homework', jsonb_build_object('keeper', v_hw_k, 'removed', v_hw_r),
      'promotions', jsonb_build_object('keeper', v_prom_k, 'removed', v_prom_r),
      'quizAttempts', jsonb_build_object('keeper', v_quiz_k, 'removed', v_quiz_r, 'conflicts', v_quiz_conf),
      'authorizedPickups', jsonb_build_object('keeper', v_pick_k, 'removed', v_pick_r),
      'releaseLogs', jsonb_build_object('keeper', v_rel_k, 'removed', v_rel_r, 'conflicts', v_rel_conf),
      'reportComments', jsonb_build_object('keeper', v_rep_k, 'removed', v_rep_r, 'conflicts', v_rep_conf),
      'enrollments', jsonb_build_object('keeperOpen', v_open_k, 'removedOpen', v_open_r, 'keeperHistory', v_hist_k, 'removedHistory', v_hist_r),
      'unhandledChildRows', v_child_rows,
      'unhandledChildTables', to_jsonb(v_child_tables)),
    'fieldStates', v_field_states,
    'transfers', v_transfer,
    'fingerprint', v_fingerprint,
    'evaluatedAt', now()
  );
END;
$$;

-- ─── 4. Privileges (re-applied because the bodies were replaced) ────────────
REVOKE ALL ON FUNCTION public.safe_duplicate_batch_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safe_duplicate_batch_policy() TO authenticated;

REVOKE ALL ON FUNCTION public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN) FROM PUBLIC;

-- ─── 5. Assertions: fail the migration rather than ship a wrong policy ──────
DO $$
DECLARE
  v_p JSONB := public.safe_duplicate_batch_policy();
  v_n INT;
BEGIN
  IF (v_p->>'version')::int <> 4 THEN
    RAISE EXCEPTION 'safe_duplicate_batch_policy() must be version 4, got %', v_p->>'version';
  END IF;
  IF NOT (v_p->'blockedCodes' @> '["parent_phone_registry_ambiguous"]'::jsonb) THEN
    RAISE EXCEPTION 'parent_phone_registry_ambiguous must be a BLOCKED code so the runner preflight can account for it';
  END IF;
  -- The codes it must NOT lose.
  IF NOT (v_p->'blockedCodes' @> '["parent_phone_conflict","parent_phone_belongs_to_other_family","transport_conflict","family_id_conflict"]'::jsonb) THEN
    RAISE EXCEPTION 'the registry must not weaken any existing blocked code';
  END IF;
  IF (v_p->'blockedCodes' @> '["family_id_invalid_normalization"]'::jsonb) THEN
    RAISE EXCEPTION 'family_id_invalid_normalization is a REVIEW code, never blocked';
  END IF;
  SELECT count(*) INTO v_n FROM public.authoritative_parent_phones;
  IF v_n <> 620 THEN
    RAISE EXCEPTION 'expected 620 authoritative parent phone numbers, seeded %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.authoritative_parent_phones
   WHERE phone <> public.normalize_phone(raw_phone);
  IF v_n > 0 THEN
    RAISE EXCEPTION '% registry rows are not the normalization of their raw value', v_n;
  END IF;
  -- Every other field's rules must be untouched by this migration.
  IF NOT (v_p->'exclusionCodes' ? 'transport_conflict'
      AND v_p->'exclusionCodes' ? 'family_id_conflict'
      AND v_p->'exclusionCodes' ? 'gov_id_conflict') THEN
    RAISE EXCEPTION 'non-phone exclusion codes went missing';
  END IF;
END
$$;
