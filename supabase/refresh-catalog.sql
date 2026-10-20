-- Catalog and service migration metadata only. No Auth users or app rows.
select jsonb_build_object(
  'postgresMajor', current_setting('server_version_num')::integer / 10000,
  'authVersions', (select coalesce(jsonb_agg(version order by version),'[]') from auth.schema_migrations),
  'extensions', (select coalesce(jsonb_agg(x order by x.name),'[]') from (
    select e.extname as name,e.extversion as version,n.nspname as schema
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  ) x),
  'tables', (select coalesce(jsonb_agg(x order by x.schema,x.name),'[]') from (
    select n.nspname as schema,c.relname as name,c.relkind::text as kind,
      c.relispartition as partition, pg_total_relation_size(c.oid)::text as bytes,
      has_table_privilege(c.oid,'SELECT') as can_read,
      has_table_privilege(c.oid,'INSERT') as can_insert,
      has_table_privilege(c.oid,'TRUNCATE') as can_truncate
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('auth','public') and c.relkind in ('r','p','m','f')
  ) x),
  'columns', (select coalesce(jsonb_agg(x order by x.schema,x.table_name,x.position),'[]') from (
    select n.nspname as schema,c.relname as table_name,a.attname as name,a.attnum as position,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
      a.attidentity::text as identity,a.attgenerated::text as generated,
      case when a.attcollation=0 then null else a.attcollation::regcollation::text end as collation,
      pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname in ('auth','public') and a.attnum>0 and not a.attisdropped and c.relkind in ('r','p','m','f')
  ) x),
  'constraints', (select coalesce(jsonb_agg(x order by x.schema,x.table_name,x.name),'[]') from (
    select n.nspname as schema,r.relname as table_name,c.conname as name,
      c.contype::text as type,pg_get_constraintdef(c.oid) as definition,c.convalidated as validated
    from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
    where n.nspname in ('auth','public')
  ) x),
  'foreignKeys', (select coalesce(jsonb_agg(x order by x.schema,x.table_name,x.name),'[]') from (
    select n.nspname as schema,r.relname as table_name,c.conname as name,
      pn.nspname as parent_schema,p.relname as parent_table,c.confmatchtype::text as match,
      array(select a.attname from unnest(c.conkey) with ordinality k(num,ord)
        join pg_attribute a on a.attrelid=r.oid and a.attnum=k.num order by k.ord) as columns,
      array(select a.attname from unnest(c.confkey) with ordinality k(num,ord)
        join pg_attribute a on a.attrelid=p.oid and a.attnum=k.num order by k.ord) as parent_columns
    from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      join pg_class p on p.oid=c.confrelid join pg_namespace pn on pn.oid=p.relnamespace
    where c.contype='f' and (n.nspname in ('auth','public') or pn.nspname in ('auth','public'))
  ) x),
  'triggers', (select coalesce(jsonb_agg(x order by x.schema,x.table_name,x.name),'[]') from (
    select n.nspname as schema,c.relname as table_name,t.tgname as name
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('auth','public') and not t.tgisinternal
  ) x),
  'sequences', (select coalesce(jsonb_agg(x order by x.schema,x.name),'[]') from (
    select n.nspname as schema,c.relname as name,tn.nspname as table_schema,t.relname as table_name,
      a.attname as column_name,s.seqincrement::text as increment,s.seqmin::text as minimum,
      s.seqmax::text as maximum,s.seqcache::text as cache,s.seqcycle as cycle,
      has_sequence_privilege(c.oid,'SELECT') as can_read,has_sequence_privilege(c.oid,'UPDATE') as can_update
    from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.deptype in ('a','i')
      left join pg_class t on t.oid=d.refobjid left join pg_namespace tn on tn.oid=t.relnamespace
      left join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
    where n.nspname in ('auth','public')
  ) x),
  'otherTables', (select coalesce(jsonb_agg(x order by x.schema,x.name),'[]') from (
    select n.nspname as schema,c.relname as name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and n.nspname not in ('auth','public','pg_catalog','information_schema')
      and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
  ) x)
) as catalog;
