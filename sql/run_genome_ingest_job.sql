EXECUTE JOB SERVICE
  IN COMPUTE POOL GRAGEN_INGEST_POOL
  NAME = GRAGEN_DB.GRAGEN.GRAGEN_GENOME_INGEST
  EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI)
  FROM SPECIFICATION $$
spec:
  containers:
  - name: seed
    image: /gragen_db/gragen/gragen_repo/gragen-service:1.0.26
    command: ["python3", "/app/seed_job.py"]
    env:
      SEED_TYPE: genomics
      SEED_CHROMS: "chr21,chr19,chr20,chr18,chr17,chr16,chr15,chr14,chr13,chr12,chr11,chr10,chr9,chr8,chr7,chr6,chr5,chr4,chr3,chr2,chr1,chrX"
      ICECHUNK_BUCKET: icechunk-ro
      ICECHUNK_GENOMICS_PREFIX: genomics_repo
      AWS_DEFAULT_REGION: us-west-2
      INGEST_WORKERS: "16"
    secrets:
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID
      envVarName: AWS_ACCESS_KEY_ID
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
      envVarName: AWS_SECRET_ACCESS_KEY
$$;
