-- Metadata only: no application rows, Auth users, sequence values, or credentials.
-- The runner executes this inside a REPEATABLE READ, READ ONLY transaction.
select jsonb_build_object(
  'tables', coalesce((select jsonb_agg(x order by x.name) from (
    select c.relname as name, c.relkind::text as kind, c.relrowsecurity as rls,
      c.relforcerowsecurity as force_rls, pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
  ) x), '[]'::jsonb),
  'columns', coalesce((select jsonb_agg(x order by x.table_name,x.position) from (
    select c.relname as table_name, a.attname as name, a.attnum as position,
      format_type(a.atttypid,a.atttypmod) as type, a.attnotnull as not_null,
      a.attidentity::text as identity, a.attgenerated::text as generated,
      pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped
  ) x), '[]'::jsonb),
  'constraints', coalesce((select jsonb_agg(x order by x.table_name,x.name) from (
    select r.relname as table_name,c.conname as name,c.contype::text as type,
      pg_get_constraintdef(c.oid) as definition,c.convalidated as validated
    from pg_constraint c join pg_class r on r.oid=c.conrelid
      join pg_namespace n on n.oid=r.relnamespace where n.nspname='public'
  ) x), '[]'::jsonb),
  'indexes', coalesce((select jsonb_agg(x order by x.table_name,x.name) from (
    select tablename as table_name,indexname as name,indexdef as definition
    from pg_indexes where schemaname='public'
  ) x), '[]'::jsonb),
  'policies', coalesce((select jsonb_agg(x order by x.table_name,x.name) from (
    select tablename as table_name,policyname as name,permissive,roles,cmd as command,
      qual as using_expression,with_check as check_expression from pg_policies where schemaname='public'
  ) x), '[]'::jsonb),
  'tableGrants', coalesce((select jsonb_agg(x order by x.table_name,x.grantee,x.privilege) from (
    select table_name,grantee,privilege_type as privilege,is_grantable
    from information_schema.table_privileges where table_schema='public'
  ) x), '[]'::jsonb),
  'functions', coalesce((select jsonb_agg(x order by x.name,x.arguments) from (
    select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result,l.lanname as language,
      p.prosecdef as security_definer,p.proconfig as settings,p.prosrc as body,
      pg_get_userbyid(p.proowner) as owner,pg_get_functiondef(p.oid) as definition,
      p.provolatile::text as volatility,p.proisstrict as strict
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' and p.prokind in ('f','p')
  ) x), '[]'::jsonb),
  'functionGrants', coalesce((select jsonb_agg(x order by x.name,x.arguments,x.grantee,x.privilege) from (
    select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type as privilege,a.is_grantable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where n.nspname='public' and p.prokind in ('f','p')
  ) x), '[]'::jsonb),
  'triggers', coalesce((select jsonb_agg(x order by x.table_name,x.name) from (
    select c.relname as table_name,t.tgname as name,pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal
  ) x), '[]'::jsonb),
  'sequences', coalesce((select jsonb_agg(x order by x.name) from (
    select c.relname as name,format_type(s.seqtypid,null) as type,s.seqstart::text as start_value,
      s.seqincrement::text as increment,s.seqmin::text as minimum,s.seqmax::text as maximum,s.seqcycle as cycle
    from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
  ) x), '[]'::jsonb),
  'defaultPrivileges', coalesce((select jsonb_agg(x order by x.owner,x.schema_name,x.object_type,x.grantee,x.privilege) from (
    select pg_get_userbyid(d.defaclrole) as owner,coalesce(n.nspname,'*') as schema_name,
      d.defaclobjtype::text as object_type,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type as privilege,a.is_grantable
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a where n.nspname='public' or d.defaclnamespace=0
  ) x), '[]'::jsonb),
  'extensions', coalesce((select jsonb_agg(x order by x.name) from (
    select e.extname as name,e.extversion as version,n.nspname as schema_name
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  ) x), '[]'::jsonb)
) as catalog;
