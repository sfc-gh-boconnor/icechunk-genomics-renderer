-- build_sfari_iceberg.sql — SFARI autism gene list → Iceberg AUTISM_GENES
-- Re-runnable: CREATE OR REPLACE + INSERT. hg38 coordinates (approx gene bounds).
-- SFARI_SCORE: 1=high confidence, 2=strong, 3=suggestive, S=syndromic.
USE WAREHOUSE GRAGEN_WH;

CREATE OR REPLACE ICEBERG TABLE GRAGEN_DB.GRAGEN.AUTISM_GENES (
  GENE        STRING  COMMENT 'Gene symbol',
  CHROM       STRING  COMMENT 'Chromosome (hg38)',
  START_POS   INT     COMMENT 'Gene start (hg38)',
  END_POS     INT     COMMENT 'Gene end (hg38)',
  SFARI_SCORE STRING  COMMENT 'SFARI gene score: 1=high,2=strong,3=suggestive,S=syndromic',
  NOTE        STRING  COMMENT 'Short description'
)
EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME' ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'
BASE_LOCATION='autism_genes/';

INSERT INTO GRAGEN_DB.GRAGEN.AUTISM_GENES (GENE, CHROM, START_POS, END_POS, SFARI_SCORE, NOTE) VALUES
  ('SHANK3','chr22',50674415,50733212,'1','Phelan-McDermid syndrome; 22q13.3'),
  ('NF2',   'chr22',29603556,29698599,'S','Neurofibromatosis type 2'),
  ('CHD8',  'chr14',21385194,21456123,'1','Most frequently mutated ASD gene'),
  ('SCN2A', 'chr2',165239385,165392212,'1','Sodium channel; ASD/epilepsy'),
  ('FOXP1', 'chr3',70954708,71583690,'1','ASD with intellectual disability'),
  ('ADNP',  'chr20',50888918,50931437,'1','Helsmoortel-Van der Aa syndrome'),
  ('ARID1B','chr6',156776434,157210779,'1','Coffin-Siris syndrome'),
  ('DYRK1A','chr21',37365790,37517341,'1','DYRK1A syndrome; microcephaly'),
  ('POGZ',  'chr1',151402057,151460296,'1','White-Sutton syndrome'),
  ('GRIN2B','chr12',13537337,13980164,'1','NMDA receptor subunit'),
  ('SYNGAP1','chr6',33388178,33420708,'1','SYNGAP1-related ID/ASD'),
  ('TBR1',  'chr2',161762250,161769017,'1','Cortical development TF'),
  ('PTEN',  'chr10',87863113,87971930,'1','Macrocephaly/ASD; PTEN hamartoma'),
  ('MECP2', 'chrX',154021573,154137103,'S','Rett syndrome'),
  ('FMR1',  'chrX',147911951,147951125,'S','Fragile X syndrome'),
  ('NRXN1', 'chr2',49918503,51225674,'1','Presynaptic neurexin'),
  ('NLGN3', 'chrX',70364571,70391051,'1','Neuroligin; X-linked ASD'),
  ('SHANK2','chr11',70640471,71255507,'1','Postsynaptic scaffold'),
  ('CNTNAP2','chr7',146116002,148420998,'2','Cortical dysplasia; ASD'),
  ('PCDH19','chrX',100279140,100338593,'S','Epilepsy/ASD in females'),
  ('ANK2',  'chr4',112949412,113355206,'1','Ankyrin-B'),
  ('TSC1',  'chr9',132891348,132945370,'S','Tuberous sclerosis 1'),
  ('TSC2',  'chr16',2047800,2089491,'S','Tuberous sclerosis 2'),
  ('MBD5',  'chr2',148422377,148946567,'1','2q23.1 microdeletion'),
  ('RELN',  'chr7',103471062,103989356,'2','Reelin; neuronal migration');
